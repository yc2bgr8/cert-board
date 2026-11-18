import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  continuationLeaseSchema,
  continuationTicketSchema,
  toolStoredPayloadSchema,
  type ContinuationLease,
  type ContinuationTicket,
  type DataLevel,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import type { ToolResultEnvelope } from '../tools/registry.js';

const id = z.string().uuid();
const ticketColumns = `t.id,t.approval_id AS "approvalId",t.decision_id AS "decisionId",
 t.invocation_id AS "invocationId",t.run_id AS "runId",t.conversation_id AS "conversationId",t.user_id AS "userId",
 t.state,t.claimed_generation AS "claimedGeneration",i.call_id AS "callId",i.tool_name AS "toolName",i.tool_version AS "toolVersion"`;
const invalid = () =>
  new AppError(
    409,
    'CONTINUATION_UNAVAILABLE',
    '继续请求不属于当前运行或状态已变化，请从原对话核对。',
  );
function dto(row: Record<string, unknown>): ContinuationTicket {
  return continuationTicketSchema.parse({
    ...row,
    claimedGeneration: row.claimedGeneration === null ? null : Number(row.claimedGeneration),
  });
}
async function transaction<T>(pool: Pool, action: (tx: PoolClient) => Promise<T>) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const result = await action(tx);
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError(
      500,
      'CONTINUATION_TRANSACTION_FAILED',
      '继续请求事务未完成，请核对保存记录；不会自动重发模型。',
    );
  } finally {
    tx.release();
  }
}
export async function getContinuationTicket(database: Pick<Pool, 'query'>, ticketId: string) {
  if (!id.safeParse(ticketId).success) throw invalid();
  const row = (
    await database.query<Record<string, unknown>>(
      `SELECT ${ticketColumns} FROM run_continuation t JOIN tool_invocation i ON i.id=t.invocation_id WHERE t.id=$1`,
      [ticketId],
    )
  ).rows[0];
  return row ? dto(row) : null;
}

// 本函数只安排已经保存的真实浏览器决定，不接受参数正文或替代身份。
export async function scheduleToolContinuation(
  tx: PoolClient,
  approvalId: string,
  decisionId: string,
) {
  const source = (
    await tx.query<{
      invocation_id: string;
      run_id: string;
      conversation_id: string;
      user_id: string;
    }>(
      `SELECT a.invocation_id,a.run_id,a.conversation_id,a.user_id
    FROM tool_approval a JOIN tool_approval_decision d ON d.approval_id=a.id
    JOIN run r ON r.id=a.run_id JOIN conversation c ON c.id=a.conversation_id
    JOIN app_user u ON u.id=a.user_id JOIN goal g ON g.id=a.goal_id
    WHERE a.id=$1 AND d.id=$2 AND d.actor_user_id=a.user_id AND d.content_hash=a.content_hash
      AND d.source_version+1=a.version AND ((d.action='reject' AND a.status='rejected') OR (d.action<>'reject' AND a.status='approved'))
      AND r.status IN ('running','waiting') AND c.status='active' AND u.status='active'
      AND g.status='active' AND g.direction_version=r.direction_version AND a.direction_version=r.direction_version`,
      [approvalId, decisionId],
    )
  ).rows[0];
  const existing = (
    await tx.query<{ id: string }>(
      'SELECT id FROM run_continuation WHERE approval_id=$1 AND decision_id=$2',
      [approvalId, decisionId],
    )
  ).rows[0];
  if (existing) return existing.id;
  if (!source) return null;
  const inserted = (
    await tx.query<{ id: string }>(
      `INSERT INTO run_continuation(approval_id,decision_id,invocation_id,run_id,conversation_id,user_id)
     VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(approval_id) DO NOTHING RETURNING id`,
      [
        approvalId,
        decisionId,
        source.invocation_id,
        source.run_id,
        source.conversation_id,
        source.user_id,
      ],
    )
  ).rows[0];
  if (inserted) return inserted.id;
  return (
    (
      await tx.query<{ id: string }>(
        'SELECT id FROM run_continuation WHERE approval_id=$1 AND decision_id=$2',
        [approvalId, decisionId],
      )
    ).rows[0]?.id ?? null
  );
}

async function lockedContext(tx: PoolClient, ticketId: string) {
  const located = (
    await tx.query<{
      project_id: string;
      goal_id: string;
      run_id: string;
      conversation_id: string;
      user_id: string;
    }>(
      `SELECT a.project_id,a.goal_id,t.run_id,t.conversation_id,t.user_id FROM run_continuation t
     JOIN tool_approval a ON a.id=t.approval_id WHERE t.id=$1`,
      [ticketId],
    )
  ).rows[0];
  if (!located) throw invalid();
  const user = (
    await tx.query<{ status: string }>('SELECT status FROM app_user WHERE id=$1 FOR SHARE', [
      located.user_id,
    ])
  ).rows[0];
  await tx.query('SELECT id FROM workspace WHERE project_id=$1 FOR UPDATE', [located.project_id]);
  const goal = (
    await tx.query<{ status: string; direction_version: number }>(
      'SELECT status,direction_version FROM goal WHERE id=$1 FOR UPDATE',
      [located.goal_id],
    )
  ).rows[0];
  const conversation = (
    await tx.query<{ status: string; permission_mode: string }>(
      'SELECT status,permission_mode FROM conversation WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [located.conversation_id, located.user_id],
    )
  ).rows[0];
  const run = (
    await tx.query<{
      status: string;
      direction_version: number;
      lease_owner: string | null;
      lease_generation: string;
      lease_expires_at: Date | null;
    }>(
      'SELECT status,direction_version,lease_owner,lease_generation,lease_expires_at FROM run WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [located.run_id, located.user_id],
    )
  ).rows[0];
  const ticketRow = (
    await tx.query<Record<string, unknown>>(
      `SELECT ${ticketColumns} FROM run_continuation t JOIN tool_invocation i ON i.id=t.invocation_id WHERE t.id=$1 FOR UPDATE OF t`,
      [ticketId],
    )
  ).rows[0];
  if (!run || !conversation || !goal || !user || !ticketRow) throw invalid();
  return { located, user, goal, conversation, run, ticket: dto(ticketRow) };
}
async function block(tx: PoolClient, ticketId: string, reasonCode: string) {
  await tx.query(
    `UPDATE run_continuation SET state='blocked',reason_code=$2,finished_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
    WHERE id=$1 AND state NOT IN ('completed','blocked')`,
    [ticketId, reasonCode],
  );
  await tx.query(
    "INSERT INTO audit_log(actor_kind,action,target_type,target_id) VALUES('system','agent.continuation_blocked','run_continuation',$1)",
    [ticketId],
  );
}

export async function prepareContinuationForDispatch(pool: Pool, ticketId: string) {
  if (!id.safeParse(ticketId).success) throw invalid();
  return transaction(pool, async (tx) => {
    const c = await lockedContext(tx, ticketId);
    if (!['pending', 'queued'].includes(c.ticket.state)) return null;
    if (
      c.user.status !== 'active' ||
      c.goal.status !== 'active' ||
      c.conversation.status !== 'active' ||
      c.goal.direction_version !== c.run.direction_version
    ) {
      await block(tx, ticketId, 'CONTINUATION_CONTEXT_CHANGED');
      return null;
    }
    if (c.ticket.state === 'queued' && c.run.status === 'queued' && c.run.lease_owner === null)
      return c.ticket;
    if (c.ticket.state !== 'pending') return null;
    if (c.run.status !== 'waiting') return null;
    const now = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
    if (c.run.lease_owner && c.run.lease_expires_at && c.run.lease_expires_at > now) return null;
    if (
      (
        await tx.query(
          `SELECT id FROM usage_ledger WHERE run_id=$1 AND status IN ('reserved','unknown') LIMIT 1`,
          [c.ticket.runId],
        )
      ).rowCount
    ) {
      await block(tx, ticketId, 'CONTINUATION_USAGE_UNCERTAIN');
      return null;
    }
    await tx.query(
      `UPDATE run SET status='queued',lease_owner=NULL,lease_expires_at=NULL,finished_at=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=$1`,
      [c.ticket.runId],
    );
    await tx.query(
      `UPDATE run_continuation SET state='queued',version=version+1,updated_at=clock_timestamp() WHERE id=$1`,
      [ticketId],
    );
    return (await getContinuationTicket(tx, ticketId))!;
  });
}

export async function listContinuationsForDispatch(pool: Pool) {
  const candidates = (
    await pool.query<{ id: string }>(
      `SELECT t.id FROM run_continuation t JOIN run r ON r.id=t.run_id
     WHERE r.trigger_type<>'evaluation' AND ((t.state='pending' AND r.status='waiting') OR (t.state='queued' AND r.status='queued'))
     ORDER BY t.created_at,t.id LIMIT 100`,
    )
  ).rows;
  const ready: ContinuationTicket[] = [];
  for (const candidate of candidates) {
    const ticket = await prepareContinuationForDispatch(pool, candidate.id);
    if (ticket) ready.push(ticket);
  }
  return ready;
}
function verifyLease(
  c: Awaited<ReturnType<typeof lockedContext>>,
  input: ContinuationLease,
  now: Date,
) {
  if (
    c.ticket.runId !== input.runId ||
    c.ticket.userId !== input.userId ||
    c.run.lease_owner !== input.ownerId ||
    Number(c.run.lease_generation) !== input.generation ||
    !c.run.lease_expires_at ||
    c.run.lease_expires_at <= now ||
    c.user.status !== 'active' ||
    c.conversation.status !== 'active'
  )
    throw invalid();
}
export async function claimContinuationForLease(pool: Pool, value: unknown) {
  const input = continuationLeaseSchema.parse(value);
  return transaction(pool, async (tx) => {
    const c = await lockedContext(tx, input.ticketId);
    verifyLease(
      c,
      input,
      (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now,
    );
    if (
      c.run.status !== 'running' ||
      c.goal.status !== 'active' ||
      c.goal.direction_version !== c.run.direction_version
    )
      throw invalid();
    if (c.ticket.state === 'claimed' && c.ticket.claimedGeneration === input.generation)
      return c.ticket;
    if (c.ticket.state !== 'queued') throw invalid();
    await tx.query(
      `UPDATE run_continuation SET state='claimed',claimed_generation=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1`,
      [input.ticketId, input.generation],
    );
    return (await getContinuationTicket(tx, input.ticketId))!;
  });
}
export async function markContinuationModelStarted(pool: Pool, value: unknown) {
  const input = continuationLeaseSchema.parse(value);
  return transaction(pool, async (tx) => {
    const c = await lockedContext(tx, input.ticketId);
    verifyLease(
      c,
      input,
      (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now,
    );
    if (c.ticket.claimedGeneration !== input.generation || c.run.status !== 'running')
      throw invalid();
    if (c.ticket.state === 'model_started') return c.ticket;
    if (c.ticket.state !== 'tool_recorded') throw invalid();
    if (
      (
        await tx.query(
          `SELECT id FROM usage_ledger WHERE run_id=$1 AND status IN ('reserved','unknown') LIMIT 1`,
          [input.runId],
        )
      ).rowCount
    )
      throw invalid();
    await tx.query(
      `UPDATE run_continuation SET state='model_started',model_started_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE id=$1`,
      [input.ticketId],
    );
    return (await getContinuationTicket(tx, input.ticketId))!;
  });
}
export async function finishContinuation(
  pool: Pool,
  value: unknown,
  outcome: { state: 'completed' | 'blocked'; reasonCode?: string },
) {
  const input = continuationLeaseSchema.parse(value);
  const result = z
    .object({
      state: z.enum(['completed', 'blocked']),
      reasonCode: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]{1,79}$/)
        .optional(),
    })
    .strict()
    .parse(outcome);
  return transaction(pool, async (tx) => {
    const c = await lockedContext(tx, input.ticketId);
    verifyLease(
      c,
      input,
      (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now,
    );
    if (c.ticket.claimedGeneration !== input.generation) throw invalid();
    if (c.ticket.state === result.state) return c.ticket;
    if (['completed', 'blocked'].includes(c.ticket.state)) throw invalid();
    if (result.state === 'blocked')
      await block(tx, input.ticketId, result.reasonCode ?? 'CONTINUATION_STOPPED');
    else {
      if (!['tool_recorded', 'model_started'].includes(c.ticket.state)) throw invalid();
      await tx.query(
        `UPDATE run_continuation SET state='completed',finished_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE id=$1`,
        [input.ticketId],
      );
    }
    return (await getContinuationTicket(tx, input.ticketId))!;
  });
}

export async function readContinuationResult(
  pool: Pick<Pool, 'query'>,
  ticketId: string,
  runId: string,
  userId: string,
) {
  if (![ticketId, runId, userId].every((value) => id.safeParse(value).success)) throw invalid();
  const row = (
    await pool.query<{
      id: string;
      call_id: string;
      tool_name: string;
      arguments_hash: string;
      invocation_id: string;
      content_json: unknown;
      data_level: DataLevel;
      undo_id: string | null;
    }>(
      `SELECT t.id,i.call_id,i.tool_name,i.arguments_hash,i.id AS invocation_id,p.content_json,
     GREATEST(p.data_level,r.max_data_level,c.max_data_level) AS data_level,u.id AS undo_id
     FROM run_continuation t JOIN tool_invocation i ON i.id=t.invocation_id
     JOIN conversation_tool_result p ON p.invocation_id=i.id AND p.conversation_id=t.conversation_id AND p.user_id=t.user_id
     JOIN run r ON r.id=t.run_id JOIN conversation c ON c.id=t.conversation_id
     LEFT JOIN undo_record u ON u.invocation_id=i.id
     WHERE t.id=$1 AND t.run_id=$2 AND t.user_id=$3 AND t.tool_recorded_at IS NOT NULL
       AND i.status IN ('completed','denied')`,
      [ticketId, runId, userId],
    )
  ).rows[0];
  if (!row) return null;
  const stored = toolStoredPayloadSchema.parse(row.content_json);
  const result: ToolResultEnvelope = {
    invocationId: row.invocation_id,
    data: stored.result.data,
    dataLevel: row.data_level,
    undoId: row.undo_id,
    replayed: true,
    status: stored.status,
  };
  return {
    ticketId: row.id,
    callId: row.call_id,
    toolName: row.tool_name,
    argumentsHash: row.arguments_hash,
    result,
    dataLevel: row.data_level,
    ...(stored.status === 'pending_proposal'
      ? { terminal: 'proposal' as const }
      : stored.status === 'completed' && row.tool_name === 'submit_for_review'
        ? { terminal: 'review' as const }
        : {}),
  };
}
