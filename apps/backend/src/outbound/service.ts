import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  outboundProcessResultSchema,
  outboundProcessOptionsSchema,
  proposalParamsSchema,
  type OutboundProcessResult,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { proposalContentHash } from './content.js';
import {
  proposalColumns,
  recipientMatches,
  type ProposalRow,
  type GoalRow,
  type ContactRow,
} from './state.js';

type QueueRow = {
  id: string;
  proposal_id: string;
  decision_id: string;
  goal_id: string;
  project_id: string;
  contact_id: string;
  approved_version: number;
  channel: string;
  status: OutboundProcessResult['status'];
  attempts: number;
  last_reason: string | null;
  receipt_id: string | null;
  processed_at: Date | null;
  version: number;
};
function result(queue: QueueRow, reason = queue.last_reason) {
  return outboundProcessResultSchema.parse({
    queueId: queue.id,
    proposalId: queue.proposal_id,
    status: queue.status,
    attempts: queue.attempts,
    reason,
    receipt:
      queue.receipt_id && queue.processed_at
        ? {
            id: queue.receipt_id,
            recordedAt: queue.processed_at.toISOString(),
            channel: 'local_test',
          }
        : null,
  });
}

export async function processTestOutbound(
  pool: Pool,
  queueId: string,
  options: { simulate?: 'success' | 'uncertain' | 'failure' } = {},
) {
  if (!['development', 'test'].includes(process.env.NODE_ENV ?? ''))
    throw new AppError(403, 'OUTBOUND_TEST_ONLY', '本地测试发送器仅能在开发或测试环境运行。');
  const parsedOptions = outboundProcessOptionsSchema.safeParse(options);
  if (!proposalParamsSchema.safeParse({ id: queueId }).success || !parsedOptions.success)
    throw new AppError(
      400,
      'OUTBOUND_PROCESS_INVALID',
      '测试处理参数无效；只允许固定的成功、不确定或失败模拟，不能提供发送函数。',
    );
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const located = await tx.query<{ goal_id: string; proposal_id: string }>(
      'SELECT goal_id,proposal_id FROM outbound_message WHERE id=$1',
      [queueId],
    );
    if (!located.rows[0])
      throw new AppError(404, 'OUTBOUND_NOT_FOUND', '没有找到待处理的本地测试队列。');
    const target = located.rows[0];
    const goals = await tx.query<GoalRow>(
      'SELECT id,project_id,owner_user_id,status,outbound_paused,version FROM goal WHERE id=$1 FOR UPDATE',
      [target.goal_id],
    );
    const proposals = await tx.query<ProposalRow>(
      `SELECT ${proposalColumns} FROM proposal p WHERE p.id=$1 FOR UPDATE`,
      [target.proposal_id],
    );
    const queues = await tx.query<QueueRow>(
      'SELECT * FROM outbound_message WHERE id=$1 FOR UPDATE',
      [queueId],
    );
    const goal = goals.rows[0],
      proposal = proposals.rows[0],
      queue = queues.rows[0];
    if (!goal || !proposal || !queue)
      throw new AppError(
        409,
        'OUTBOUND_CONTEXT_INVALID',
        '队列的目标或提案记录不完整，已停止处理。',
      );
    if (queue.status !== 'queued') {
      await tx.query('COMMIT');
      return result(queue);
    }
    const fail = async (reason: string) => {
      const changed = await tx.query<QueueRow>(
        "UPDATE outbound_message SET status='failed',last_reason=$1,processed_at=CURRENT_TIMESTAMP,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$2 RETURNING *",
        [reason, queueId],
      );
      if (proposal.status === 'approved' && proposal.version === queue.approved_version)
        await tx.query(
          "UPDATE proposal SET status='failed',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
          [proposal.id],
        );
      await tx.query(
        "INSERT INTO audit_log(actor_kind,action,target_type,target_id) VALUES('system','outbound.blocked','outbound_message',$1)",
        [queueId],
      );
      await tx.query('COMMIT');
      return result(changed.rows[0]!);
    };
    if (goal.status !== 'active')
      return await fail('目标不是活动状态，已停止本地测试处理；未对外发送。');
    if (goal.outbound_paused) {
      await tx.query('COMMIT');
      return result(queue, '外发已暂停，保持未执行；恢复后需要重新批准。');
    }
    const decisions = await tx.query<{
      proposal_id: string;
      source_version: number;
      action: string;
      content_hash: string;
    }>('SELECT proposal_id,source_version,action,content_hash FROM decision WHERE id=$1', [
      queue.decision_id,
    ]);
    const approved = decisions.rows[0];
    if (
      queue.attempts !== 0 ||
      queue.channel !== 'local_test' ||
      proposal.channel !== 'local_test' ||
      proposal.dataLevel !== 'internal' ||
      proposal.goalId !== goal.id ||
      proposal.projectId !== goal.project_id ||
      queue.goal_id !== goal.id ||
      queue.project_id !== proposal.projectId ||
      proposal.status !== 'approved' ||
      proposal.version !== queue.approved_version ||
      !approved ||
      approved.action !== 'approved' ||
      approved.proposal_id !== proposal.id ||
      approved.source_version + 1 !== queue.approved_version ||
      approved.content_hash !== proposal.contentHash ||
      proposalContentHash(proposal) !== proposal.contentHash
    )
      return await fail('批准来源、内容或版本校验未通过，未执行本地测试，也未对外发送。');
    const contacts = await tx.query<ContactRow>(
      'SELECT id,project_id,name,address,version,active,channel FROM contact WHERE id=$1 FOR SHARE',
      [queue.contact_id],
    );
    if (!recipientMatches(proposal, contacts.rows[0]))
      return await fail('收件人登记已失效或改变，未执行本地测试；请重新建立提案审核。');
    await tx.query(
      "UPDATE proposal SET status='executing',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
      [proposal.id],
    );
    const simulation = parsedOptions.data.simulate;
    const status =
      simulation === 'success' ? 'done' : simulation === 'uncertain' ? 'reconcile' : 'failed';
    const reason =
      simulation === 'success'
        ? '本地测试回执已记录，未向任何外部对象发送。'
        : simulation === 'uncertain'
          ? '本地测试模拟结果不确定，已进入对账状态，不会自动重放。'
          : '本地测试模拟失败，未向任何外部对象发送。';
    const processed = await tx.query<QueueRow>(
      `UPDATE outbound_message SET status=$1,attempts=1,last_reason=$2,receipt_id=$3,processed_at=CURRENT_TIMESTAMP,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$4 RETURNING *`,
      [status, reason, simulation === 'success' ? randomUUID() : null, queueId],
    );
    await tx.query(
      'UPDATE proposal SET status=$1,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$2',
      [status, proposal.id],
    );
    await tx.query(
      "INSERT INTO audit_log(actor_kind,action,target_type,target_id) VALUES('system',$1,'outbound_message',$2)",
      [`outbound.${status}`, queueId],
    );
    await tx.query('COMMIT');
    return result(processed.rows[0]!);
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError(
      500,
      'OUTBOUND_PROCESS_FAILED',
      '本地测试事务失败，记录未完成，请核对状态后重试；没有调用任何外部发送渠道。',
    );
  } finally {
    tx.release();
  }
}
