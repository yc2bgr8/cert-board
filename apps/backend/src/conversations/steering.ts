import type { Pool, PoolClient } from 'pg';
import {
  runLeaseIdentitySchema,
  steeringDeliveryBatchSchema,
  conversationUserTextSchema,
  type RunLeaseIdentity,
  type SteeringDelivery,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { appendConversationMessageTx } from './storage.js';

const unavailable = () =>
  new AppError(
    409,
    'STEERING_LEASE_UNAVAILABLE',
    '当前运行已停止、身份或执行权已变化，插话仍保留在原运行中，请核对对话记录。',
  );
async function assertCurrentLease(tx: PoolClient, lease: RunLeaseIdentity) {
  const row = await tx.query(
    `SELECT id FROM run WHERE id=$1 AND user_id=$2 AND status='running'
      AND lease_owner=$3 AND lease_generation=$4 AND lease_expires_at>clock_timestamp()`,
    [lease.runId, lease.userId, lease.ownerId, lease.generation],
  );
  if (row.rowCount !== 1) throw unavailable();
}

// 只在工具批次闭合后调用；消息在返回内核之前已与投递标记一起提交，调用者不能再次追加。
export async function takeSteeringForLease(
  pool: Pool,
  value: unknown,
): Promise<SteeringDelivery[]> {
  const parsed = runLeaseIdentitySchema.safeParse(value);
  if (!parsed.success) throw unavailable();
  const lease = parsed.data;
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const located = (
      await tx.query<{
        conversation_id: string;
        project_id: string | null;
        goal_id: string | null;
      }>('SELECT conversation_id,project_id,goal_id FROM run WHERE id=$1 AND user_id=$2', [
        lease.runId,
        lease.userId,
      ])
    ).rows[0];
    if (!located) throw unavailable();
    const user = (
      await tx.query<{ is_development: boolean }>(
        "SELECT is_development FROM app_user WHERE id=$1 AND status='active' FOR SHARE",
        [lease.userId],
      )
    ).rows[0];
    if (!user || (process.env.NODE_ENV === 'production' && user.is_development))
      throw unavailable();
    if (located.project_id)
      await tx.query('SELECT id FROM workspace WHERE project_id=$1 FOR UPDATE', [
        located.project_id,
      ]);
    let direction: number | undefined;
    if (located.goal_id) {
      const goal = (
        await tx.query<{ direction_version: number }>(
          "SELECT direction_version FROM goal WHERE id=$1 AND project_id=$2 AND status='active' FOR SHARE",
          [located.goal_id, located.project_id],
        )
      ).rows[0];
      if (!goal) throw unavailable();
      direction = goal.direction_version;
    }
    const conversation = await tx.query(
      "SELECT id FROM conversation WHERE id=$1 AND user_id=$2 AND status='active' FOR UPDATE",
      [located.conversation_id, lease.userId],
    );
    if (conversation.rowCount !== 1) throw unavailable();
    const run = (
      await tx.query<{ direction_version: number; conversation_id: string }>(
        'SELECT direction_version,conversation_id FROM run WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [lease.runId, lease.userId],
      )
    ).rows[0];
    if (
      !run ||
      run.conversation_id !== located.conversation_id ||
      (direction !== undefined && run.direction_version !== direction)
    )
      throw unavailable();
    await assertCurrentLease(tx, lease);
    const pending = (
      await tx.query<{ id: string; request_key: string; content: string }>(
        `SELECT id,request_key,content FROM run_steering_message
       WHERE run_id=$1 AND conversation_id=$2 AND user_id=$3 AND delivered_at IS NULL
       ORDER BY created_at,id LIMIT 8 FOR UPDATE`,
        [lease.runId, located.conversation_id, lease.userId],
      )
    ).rows;
    const deliveries: SteeringDelivery[] = [];
    let characters = 0;
    for (const row of pending) {
      const content = conversationUserTextSchema.parse(row.content);
      if (characters + content.length > 32000) break;
      const message = { role: 'user' as const, content };
      const saved = await appendConversationMessageTx(tx, {
        runId: lease.runId,
        userId: lease.userId,
        requestKey: row.request_key,
        message,
      });
      const updated = await tx.query(
        `UPDATE run_steering_message SET delivered_message_id=$2,delivered_seq=$3,
          delivered_at=clock_timestamp(),delivered_generation=$4 WHERE id=$1 AND delivered_at IS NULL`,
        [row.id, saved.id, saved.seq, lease.generation],
      );
      if (updated.rowCount !== 1) throw unavailable();
      deliveries.push({ steeringId: row.id, messageId: saved.id, seq: saved.seq, message });
      characters += content.length;
    }
    const result = steeringDeliveryBatchSchema.parse(deliveries);
    await assertCurrentLease(tx, lease);
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError(
      500,
      'STEERING_DELIVERY_FAILED',
      '插话尚未交给Agent，本次投递已回滚，原始消息仍保留，请核对运行状态。',
    );
  } finally {
    tx.release();
  }
}
