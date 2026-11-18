import { PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { Pool } from 'pg';
import { lockOwnedRun } from '../runs/lock.js';
import { appendConversationEvent } from '../conversations/storage.js';

export const AGENT_QUEUE = 'cert-agent-runs';
const jobSchema = z
  .object({ runId: z.string().uuid(), ticketId: z.string().uuid().optional() })
  .strict();
type AgentJob = z.infer<typeof jobSchema>;

export async function createAgentQueue(connectionString: string, onError: () => void) {
  const boss = new PgBoss({
    connectionString,
    schedule: false,
    application_name: 'cert-board-queue',
    connectionTimeoutMillis: 5000,
  });
  boss.on('error', () => {
    try {
      onError();
    } catch {
      /* 观察回调不能泄露底层错误或阻断资源清理。 */
    }
  });
  const policy = {
    retryLimit: 0,
    expireInSeconds: 900,
    retentionSeconds: 86400,
    heartbeatSeconds: 60,
  };
  try {
    await boss.start();
    await boss.createQueue(AGENT_QUEUE, { policy: 'standard', ...policy });
    await boss.updateQueue(AGENT_QUEUE, policy);
    if ((await boss.getQueue(AGENT_QUEUE))?.policy !== 'standard') throw new Error('queue_policy');
    return boss;
  } catch {
    await boss.stop({ graceful: false }).catch(() => undefined);
    throw new Error('AGENT_QUEUE_START_FAILED');
  }
}

export async function enqueueAgentRun(boss: PgBoss, runId: string, ticketId?: string) {
  const parsed = jobSchema.safeParse({ runId, ...(ticketId ? { ticketId } : {}) });
  if (!parsed.success) throw new Error('INVALID_AGENT_JOB');
  return boss.send(AGENT_QUEUE, parsed.data, { id: ticketId ?? runId, retryLimit: 0 });
}

export async function consumeAgentRuns(
  boss: PgBoss,
  handler: (runId: string, signal: AbortSignal, ticketId?: string) => Promise<void>,
  closing: () => boolean,
  onFailure?: (runId: string, ticketId?: string) => Promise<void>,
) {
  return boss.work<AgentJob>(
    AGENT_QUEUE,
    { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 1 },
    async (jobs) => {
      for (const job of jobs) {
        const parsed = jobSchema.safeParse(job.data);
        const data =
          parsed.success && job.id === (parsed.data.ticketId ?? parsed.data.runId)
            ? parsed.data
            : null;
        try {
          if (!data) throw new Error('INVALID_AGENT_JOB');
          if (closing() || job.signal.aborted) throw new Error('AGENT_WORKER_CLOSING');
          await handler(data.runId, job.signal, data.ticketId);
          if (job.signal.aborted) throw new Error('AGENT_JOB_ABORTED');
        } catch {
          if (data) await onFailure?.(data.runId, data.ticketId).catch(() => undefined);
          const error = new Error('AGENT_JOB_FAILED');
          delete error.stack;
          throw error;
        }
        // 队列只存运行和续跑票据编号，回执正文保存在私有对话中。
      }
    },
  );
}

export async function finishAbandonedAgentRun(
  pool: Pool,
  runId: string,
  allowQueued = false,
  ticketId?: string,
) {
  if (!jobSchema.safeParse({ runId, ...(ticketId ? { ticketId } : {}) }).success)
    throw new Error('INVALID_AGENT_JOB');
  const tx = await pool.connect();
  let notice: { userId: string; status: 'failed' | 'stopped'; requestKey: string } | undefined;
  try {
    await tx.query('BEGIN');
    await tx.query("SET LOCAL lock_timeout='1000ms'");
    const owner = (
      await tx.query<{ user_id: string }>('SELECT user_id FROM run WHERE id=$1', [runId])
    ).rows[0];
    if (!owner) {
      await tx.query('COMMIT');
      return false;
    }
    const row = await lockOwnedRun(tx, runId, owner.user_id);
    const clock = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
    const stale =
      row.status === 'running' &&
      (!row.lease_owner || !row.lease_expires_at || row.lease_expires_at <= clock);
    const activeTicket = (
      await tx.query<{ id: string }>(
        "SELECT id FROM run_continuation WHERE run_id=$1 AND state='queued' ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
        [runId],
      )
    ).rows[0];
    const unstarted =
      row.status === 'queued' &&
      (allowQueued || BigInt(row.lease_generation) > 0n) &&
      (!activeTicket || (allowQueued && activeTicket.id === ticketId));
    if (!stale && !unstarted) {
      await tx.query('COMMIT');
      return false;
    }
    const status = unstarted && BigInt(row.lease_generation) === 0n ? 'failed' : 'stopped';
    await tx.query(
      `UPDATE run SET status=$1,lease_owner=NULL,lease_expires_at=NULL,
       finished_at=COALESCE(finished_at,CURRENT_TIMESTAMP),version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$2`,
      [status, runId],
    );
    await tx.query(
      `UPDATE run_continuation SET state='blocked',reason_code='CONTINUATION_INTERRUPTED',
       version=version+1,finished_at=clock_timestamp(),updated_at=clock_timestamp()
       WHERE run_id=$1 AND state NOT IN ('completed','blocked')`,
      [runId],
    );
    await tx.query(
      "INSERT INTO audit_log(actor_kind,action,target_type,target_id) VALUES('system',$1,'run',$2)",
      [unstarted ? 'agent.queue_failed' : 'agent.worker_interrupted', runId],
    );
    await tx.query('COMMIT');
    notice = { userId: owner.user_id, status, requestKey: runId };
  } catch {
    await tx.query('ROLLBACK').catch(() => undefined);
    throw new Error('AGENT_RUN_RECOVERY_DEFERRED');
  } finally {
    tx.release();
  }
  if (notice) {
    try {
      await appendConversationEvent(pool, {
        runId,
        userId: notice.userId,
        requestKey: notice.requestKey,
        event: {
          type: 'run_status',
          payload: {
            status: notice.status,
            reasonCode: 'WORKER_INTERRUPTED',
            message:
              '后台运行已停止，未重放模型或工具操作。请核对已保存结果和未完成事项后重新发起任务。',
          },
        },
      });
    } catch {
      await pool
        .query(
          "INSERT INTO audit_log(actor_kind,action,target_type,target_id) VALUES('system','agent.recovery_notice_failed','run',$1)",
          [runId],
        )
        .catch(() => {
          try {
            console.warn('AGENT_RECOVERY_NOTICE_DEFERRED');
          } catch {
            /* 保留已提交终态。 */
          }
        });
    }
  }
  return true;
}

export async function recoverAbandonedAgentRuns(pool: Pool) {
  const candidates = await pool.query<{ id: string }>(
    `SELECT id FROM run WHERE
     (status='running' AND (lease_owner IS NULL OR lease_expires_at<=clock_timestamp()))
     OR (status='queued' AND lease_generation>0 AND NOT EXISTS(
       SELECT 1 FROM run_continuation t WHERE t.run_id=run.id AND t.state='queued'
     )) ORDER BY created_at,id LIMIT 100`,
  );
  let stopped = 0;
  for (const row of candidates.rows) if (await finishAbandonedAgentRun(pool, row.id)) stopped++;
  return { stopped, hasMore: candidates.rows.length === 100 };
}
