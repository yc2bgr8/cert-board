import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  internalMessageInputSchema,
  internalMessageQueuedSchema,
  internalMessageProcessSchema,
  outboundProcessOptionsSchema,
  type InternalMessageInput,
  type ToolApprovalPreview,
  type InternalMessageProcess,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import type { ToolExecutionContext, ToolUndoRecord } from '../tools/registry.js';

type Recipient = {
  id: string;
  version: number;
  name: string;
  address: string;
  internal_user_id: string;
  user_version: number;
};
type QueueRow = {
  id: string;
  run_id: string;
  conversation_id: string;
  user_id: string;
  project_id: string;
  goal_id: string;
  direction_version: number;
  contact_id: string;
  recipient_user_id: string;
  recipient_version: number;
  recipient_user_version: number;
  recipient_name: string;
  recipient_address: string;
  subject: string;
  body: string;
  channel: string;
  content_hash: string;
  data_level: string;
  status: InternalMessageProcess['status'];
  attempts: number;
  last_reason: string | null;
  receipt_id: string | null;
  processed_at: Date | null;
  version: number;
  invocation_id: string;
  business_date: string;
};
const testOnly = () => {
  if (!['development', 'test'].includes(process.env.NODE_ENV ?? ''))
    throw new AppError(
      403,
      'INTERNAL_TEST_ONLY',
      '当前内部消息仅支持开发测试渠道，生产环境不能使用。',
    );
};
const digest = (value: InternalMessageInput) =>
  createHash('sha256')
    .update(
      JSON.stringify({ contactId: value.contactId, subject: value.subject, body: value.body }),
    )
    .digest('hex');
async function reminderDay(tx: PoolClient) {
  return (
    await tx.query<{ day: string; workday: boolean }>(
      `WITH local_date AS MATERIALIZED (
         SELECT (public.internal_reminder_now() AT TIME ZONE 'Asia/Shanghai')::date AS day
       ) SELECT day::text, extract(isodow FROM day) BETWEEN 1 AND 5 AS workday FROM local_date`,
    )
  ).rows[0]!;
}
async function confidential(
  tx: PoolClient,
  projectId: string,
  conversationId: string,
  runId: string,
) {
  const row = (
    await tx.query<{ blocked: boolean }>(
      `SELECT
    EXISTS(SELECT 1 FROM conversation WHERE id=$2 AND max_data_level='confidential') OR
    EXISTS(SELECT 1 FROM run WHERE id=$3 AND max_data_level='confidential') OR
    EXISTS(SELECT 1 FROM workspace WHERE project_id=$1 AND data_level='confidential') OR
    EXISTS(SELECT 1 FROM document d JOIN document_version v ON v.document_id=d.id WHERE d.project_id=$1 AND v.data_level='confidential') OR
    EXISTS(SELECT 1 FROM workspace_version WHERE project_id=$1 AND data_level='confidential') OR
    EXISTS(SELECT 1 FROM workspace_draft WHERE project_id=$1 AND data_level='confidential') AS blocked`,
      [projectId, conversationId, runId],
    )
  ).rows[0];
  return row?.blocked !== false;
}
async function recipient(tx: PoolClient, contactId: string, projectId: string): Promise<Recipient> {
  const row = (
    await tx.query<Recipient>(
      `SELECT c.id,c.version,c.name,c.address,c.internal_user_id,u.version AS user_version
    FROM contact c JOIN app_user u ON u.id=c.internal_user_id
    WHERE c.id=$1 AND c.project_id=$2 AND c.active=true AND c.channel='local_test'
      AND u.status='active' AND u.is_development=true FOR SHARE OF c,u`,
      [contactId, projectId],
    )
  ).rows[0];
  if (!row)
    throw new AppError(
      422,
      'INTERNAL_RECIPIENT_UNBOUND',
      '收件人未绑定本项目有效的开发成员测试身份，请核对登记；公司外部消息请使用propose_external。',
    );
  return row;
}
async function requestContext(ctx: ToolExecutionContext, input: unknown) {
  testOnly();
  const data = internalMessageInputSchema.parse(input);
  if (
    !ctx.projectId ||
    !ctx.goalId ||
    ctx.goalStatus !== 'active' ||
    ctx.permissionMode === 'read_only'
  )
    throw new AppError(
      403,
      'INTERNAL_CONTEXT_INVALID',
      '内部消息需要活动目标及有写入权限的本人对话，请先核对模式和事项状态。',
    );
  const goal = (
    await ctx.tx.query<{ version: number; outbound_paused: boolean }>(
      'SELECT version,outbound_paused FROM goal WHERE id=$1 AND project_id=$2 AND direction_version=$3',
      [ctx.goalId, ctx.projectId, ctx.directionVersion],
    )
  ).rows[0];
  if (!goal || goal.outbound_paused)
    throw new AppError(
      409,
      'INTERNAL_OUTBOUND_PAUSED',
      '此事项外发已暂停或方向已变更，请先在浏览器核对后重新提出消息。',
    );
  if (!(await reminderDay(ctx.tx)).workday)
    throw new AppError(
      409,
      'INTERNAL_REMINDER_WEEKEND',
      '周六、周日不催办，请在北京时间下一个工作日重新提出。',
    );
  if (
    ctx.maxDataLevel === 'confidential' ||
    (await confidential(ctx.tx, ctx.projectId, ctx.conversationId, ctx.runId))
  )
    throw new AppError(
      403,
      'INTERNAL_DATA_RESTRICTED',
      '当前事项涉及保密资料，不能进入内部测试消息队列，请改用已批准的保密处理方式。',
    );
  return { data, goal, recipient: await recipient(ctx.tx, data.contactId, ctx.projectId) };
}
export async function previewInternalMessage(
  ctx: ToolExecutionContext,
  input: unknown,
): Promise<ToolApprovalPreview> {
  const value = await requestContext(ctx, input);
  return {
    summary: '为已登记内部同事排入一条本地测试消息，不向真实对象发送。',
    changes: [],
    message: {
      contactId: value.data.contactId,
      recipientName: value.recipient.name,
      subject: value.data.subject,
      body: value.data.body,
    },
    targetVersions: [
      {
        targetType: 'contact',
        targetId: value.recipient.id,
        version: String(value.recipient.version),
      },
      {
        targetType: 'app_user',
        targetId: value.recipient.internal_user_id,
        version: String(value.recipient.user_version),
      },
      { targetType: 'goal', targetId: ctx.goalId!, version: String(value.goal.version) },
    ],
    dataLevel: 'internal',
  };
}
export async function enqueueInternalMessage(
  ctx: ToolExecutionContext,
  input: unknown,
  queueId: string,
) {
  const value = await requestContext(ctx, input);
  if (!z.string().uuid().safeParse(queueId).success)
    throw new AppError(400, 'INTERNAL_QUEUE_ID_INVALID', '消息队列编号无效，不能执行。');
  const invocation = (
    await ctx.tx.query<{ id: string }>(
      `SELECT id FROM tool_invocation WHERE run_id=$1 AND call_id=$2 AND user_id=$3 AND conversation_id=$4
    AND tool_name='queue_internal_message' AND effect='reversible_write' AND operation='execute' AND status='started'`,
      [ctx.runId, ctx.callId, ctx.actor.userId, ctx.conversationId],
    )
  ).rows[0];
  if (!invocation)
    throw new AppError(
      403,
      'INTERNAL_REGISTERED_TOOL_REQUIRED',
      '内部消息只能由登记工具按当前模式排队。',
    );
  try {
    await ctx.tx.query(
      `INSERT INTO internal_outbound_message(id,invocation_id,run_id,conversation_id,user_id,project_id,goal_id,direction_version,
      contact_id,recipient_user_id,recipient_version,recipient_user_version,recipient_name,recipient_address,channel,subject,body,content_hash,data_level)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'local_test',$15,$16,$17,'internal')`,
      [
        queueId,
        invocation.id,
        ctx.runId,
        ctx.conversationId,
        ctx.actor.userId,
        ctx.projectId,
        ctx.goalId,
        ctx.directionVersion,
        value.recipient.id,
        value.recipient.internal_user_id,
        value.recipient.version,
        value.recipient.user_version,
        value.recipient.name,
        value.recipient.address,
        value.data.subject,
        value.data.body,
        digest(value.data),
      ],
    );
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505')
      throw new AppError(
        409,
        'INTERNAL_DAILY_LIMIT',
        '同一事项今天已有发给该同事的消息，请核对队列，不要重复催办；未处理消息可先撤销。',
      );
    throw error;
  }
  await ctx.tx.query(
    "INSERT INTO audit_log(actor_user_id,actor_kind,action,target_type,target_id,after_hash) VALUES($1,'agent','internal_message.queued','internal_outbound_message',$2,$3)",
    [ctx.actor.userId, queueId, digest(value.data)],
  );
  return {
    data: internalMessageQueuedSchema.parse({
      queueId,
      status: 'queued',
      channel: 'local_test',
      recipientName: value.recipient.name,
      sent: false,
    }),
    dataLevel: 'internal' as const,
    afterVersion: '1',
  };
}
export async function internalMessageVersion(ctx: ToolExecutionContext, queueId: string) {
  const row = (
    await ctx.tx.query<{ version: number }>(
      'SELECT version FROM internal_outbound_message WHERE id=$1 AND user_id=$2 AND conversation_id=$3 FOR UPDATE',
      [queueId, ctx.actor.userId, ctx.conversationId],
    )
  ).rows[0];
  return row ? String(row.version) : null;
}

export async function refreshInternalMessageLevel(ctx: ToolExecutionContext, cached: unknown) {
  const data = internalMessageQueuedSchema.parse(cached);
  const row = (
    await ctx.tx.query<{ status: string; attempts: number }>(
      'SELECT status,attempts FROM internal_outbound_message WHERE id=$1 AND user_id=$2 AND conversation_id=$3',
      [data.queueId, ctx.actor.userId, ctx.conversationId],
    )
  ).rows[0];
  const operation = (
    await ctx.tx.query<{ operation: string }>(
      "SELECT operation FROM tool_invocation WHERE run_id=$1 AND call_id=$2 AND user_id=$3 AND tool_name='queue_internal_message'",
      [ctx.runId, ctx.callId, ctx.actor.userId],
    )
  ).rows[0]?.operation;
  if (!row || (operation !== 'undo' && (row.status !== 'queued' || row.attempts !== 0)))
    throw new AppError(
      409,
      'INTERNAL_QUEUE_CHANGED',
      '消息已撤销或已处理，请读取当前队列回执，不要复用旧调用编号。',
    );
  return ctx.maxDataLevel === 'confidential' ||
    (await confidential(ctx.tx, ctx.projectId!, ctx.conversationId, ctx.runId))
    ? ('confidential' as const)
    : ('internal' as const);
}
export async function cancelInternalMessage(ctx: ToolExecutionContext, record: ToolUndoRecord) {
  const changed = await ctx.tx.query<{ version: number }>(
    `UPDATE internal_outbound_message SET status='cancelled',version=version+1,updated_at=CURRENT_TIMESTAMP
    WHERE id=$1 AND user_id=$2 AND conversation_id=$3 AND status='queued' AND attempts=0 AND version=$4 RETURNING version`,
    [record.targetId, ctx.actor.userId, ctx.conversationId, Number(record.afterVersion)],
  );
  if (!changed.rows[0])
    throw new AppError(
      409,
      'INTERNAL_MESSAGE_NOT_REVERSIBLE',
      '消息已处理或版本改变，不能撤销或自动重放，请先核对回执。',
    );
  return { afterVersion: String(changed.rows[0].version) };
}
function processResult(row: QueueRow, reason = row.last_reason) {
  return internalMessageProcessSchema.parse({
    queueId: row.id,
    status: row.status,
    attempts: row.attempts,
    reason,
    receipt:
      row.receipt_id && row.processed_at
        ? { id: row.receipt_id, recordedAt: row.processed_at.toISOString(), channel: 'local_test' }
        : null,
  });
}
export async function processTestInternalMessage(pool: Pool, queueId: string, input: unknown = {}) {
  testOnly();
  const options = outboundProcessOptionsSchema.safeParse(input);
  if (!z.string().uuid().safeParse(queueId).success || !options.success)
    throw new AppError(
      400,
      'INTERNAL_PROCESS_INVALID',
      '本地测试处理只接受队列编号和固定模拟结果，不接受发送函数或地址。',
    );
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const located = (
      await tx.query<QueueRow>(
        'SELECT *,business_date::text AS business_date FROM internal_outbound_message WHERE id=$1',
        [queueId],
      )
    ).rows[0];
    if (!located) throw new AppError(404, 'INTERNAL_MESSAGE_MISSING', '没有找到本地测试队列。');
    const sender = (
      await tx.query<{ status: string }>('SELECT status FROM app_user WHERE id=$1 FOR SHARE', [
        located.user_id,
      ])
    ).rows[0];
    await tx.query('SELECT id FROM workspace WHERE project_id=$1 FOR SHARE', [located.project_id]);
    const goal = (
      await tx.query<{ status: string; direction_version: number; outbound_paused: boolean }>(
        'SELECT status,direction_version,outbound_paused FROM goal WHERE id=$1 AND project_id=$2 FOR UPDATE',
        [located.goal_id, located.project_id],
      )
    ).rows[0];
    const conversation = (
      await tx.query<{ status: string; permission_mode: string }>(
        'SELECT status,permission_mode FROM conversation WHERE id=$1 AND user_id=$2 FOR SHARE',
        [located.conversation_id, located.user_id],
      )
    ).rows[0];
    const run = (
      await tx.query<{ status: string; direction_version: number }>(
        'SELECT status,direction_version FROM run WHERE id=$1 AND user_id=$2 AND conversation_id=$3 FOR SHARE',
        [located.run_id, located.user_id, located.conversation_id],
      )
    ).rows[0];
    const row = (
      await tx.query<QueueRow>(
        'SELECT *,business_date::text AS business_date FROM internal_outbound_message WHERE id=$1 FOR UPDATE',
        [queueId],
      )
    ).rows[0]!;
    if (row.status !== 'queued') {
      await tx.query('COMMIT');
      return processResult(row);
    }
    const fail = async (reason: string) => {
      const changed = (
        await tx.query<QueueRow>(
          "UPDATE internal_outbound_message SET status='failed',last_reason=$1,processed_at=CURRENT_TIMESTAMP,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$2 RETURNING *",
          [reason, queueId],
        )
      ).rows[0]!;
      await tx.query(
        "INSERT INTO audit_log(actor_kind,action,target_type,target_id) VALUES('system','internal_message.blocked','internal_outbound_message',$1)",
        [queueId],
      );
      await tx.query('COMMIT');
      return processResult(changed);
    };
    const today = await reminderDay(tx);
    if (!today.workday)
      return await fail('周末暂停催办，未处理的旧消息不会补发。请在下一个工作日重新核对后提出。');
    if (row.business_date !== today.day)
      return await fail('未处理消息已跨北京时间日期，已失效且不会补发；请核对当前事项后重新提出。');
    if (
      sender?.status !== 'active' ||
      !goal ||
      goal.status !== 'active' ||
      goal.direction_version !== row.direction_version ||
      !run ||
      run.direction_version !== row.direction_version ||
      ['stopped', 'failed', 'budget_exhausted'].includes(run.status) ||
      conversation?.status !== 'active' ||
      conversation.permission_mode === 'read_only'
    )
      return await fail('发起人、事项、运行或权限状态改变，已停止本地测试处理，没有发送。');
    if (goal.outbound_paused) {
      await tx.query('COMMIT');
      return processResult(row, '事项外发已暂停，本地测试消息尚未处理。');
    }
    const invocation = (
      await tx.query<{ status: string }>(
        `SELECT status FROM tool_invocation WHERE id=$1 AND run_id=$2 AND conversation_id=$3 AND user_id=$4 AND tool_name='queue_internal_message' AND effect='reversible_write' AND operation='execute'`,
        [row.invocation_id, row.run_id, row.conversation_id, row.user_id],
      )
    ).rows[0];
    if (
      invocation?.status !== 'completed' ||
      row.attempts !== 0 ||
      row.channel !== 'local_test' ||
      row.data_level !== 'internal' ||
      digest({ contactId: row.contact_id, subject: row.subject, body: row.body }) !==
        row.content_hash ||
      (await confidential(tx, row.project_id, row.conversation_id, row.run_id))
    )
      return await fail('工具来源、消息内容或资料级别校验未通过，未进行本地测试处理。');
    let person: Recipient;
    try {
      person = await recipient(tx, row.contact_id, row.project_id);
    } catch (error) {
      if (error instanceof AppError) return await fail('收件身份失效，请重新核对登记后提出消息。');
      throw error;
    }
    if (
      person.internal_user_id !== row.recipient_user_id ||
      person.version !== row.recipient_version ||
      person.user_version !== row.recipient_user_version ||
      person.name !== row.recipient_name ||
      person.address !== row.recipient_address
    )
      return await fail('收件人登记或绑定版本改变，请重新核对后提出消息。');
    const status =
      options.data.simulate === 'success'
        ? 'done'
        : options.data.simulate === 'uncertain'
          ? 'reconcile'
          : 'failed';
    const reason =
      status === 'done'
        ? '已登记本地测试回执，未向任何真实对象发送消息。'
        : status === 'reconcile'
          ? '本地测试模拟结果不确定，不会自动重放。'
          : '本地测试模拟失败，未向真实对象发送消息。';
    const changed = (
      await tx.query<QueueRow>(
        `WITH processing_clock AS MATERIALIZED (
           SELECT clock_timestamp() AS at, (public.internal_reminder_now() AT TIME ZONE 'Asia/Shanghai')::date AS day
         )
         UPDATE internal_outbound_message q SET status=$1,attempts=1,last_reason=$2,receipt_id=$3,processed_at=t.at,version=version+1,updated_at=t.at
         FROM processing_clock t
         WHERE q.id=$4 AND q.business_date=t.day AND extract(isodow FROM t.day) BETWEEN 1 AND 5
         RETURNING q.*`,
        [status, reason, status === 'done' ? randomUUID() : null, queueId],
      )
    ).rows[0]!;
    if (!changed) return await fail('消息处理前已跨北京时间日期，未补发；请核对事项后重新提出。');
    await tx.query(
      "INSERT INTO audit_log(actor_kind,action,target_type,target_id) VALUES('system',$1,'internal_outbound_message',$2)",
      [`internal_message.${status}`, queueId],
    );
    await tx.query('COMMIT');
    return processResult(changed);
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError(
      500,
      'INTERNAL_PROCESS_FAILED',
      '内部本地测试事务未完成，请核对队列记录；没有调用真实发送渠道。',
    );
  } finally {
    tx.release();
  }
}
