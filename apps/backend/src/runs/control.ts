import type { Pool, PoolClient } from 'pg';
import {
  browserIdentitySchema,
  runStopParamsSchema,
  runControlNotificationSchema,
  runStopResultSchema,
  type BrowserIdentity,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { authorize } from '../auth/authorization.js';
import { lockOwnedRun } from './lock.js';
import {
  cancelVerificationWaitsTx,
  stopReviewVerificationTx,
} from '../goals/verification-wakeups.js';
import { cancelGoalWaitTx, finishGoalWakeTx } from '../goals/goal-events.js';

export const RUN_CONTROL_CHANNEL = 'cert_board_run_control_v1';
type Database = Pick<Pool, 'query'>;
const unavailable = () => new AppError(404, 'RUN_STOP_FORBIDDEN', '没有找到本人有权控制的运行。');

export async function authorizeRunStop(db: Database, input: BrowserIdentity, runId: string) {
  const parsed = browserIdentitySchema.safeParse(input);
  if (!parsed.success || !runStopParamsSchema.safeParse({ id: runId }).success) throw unavailable();
  const actor = parsed.data;
  const found = await db.query<{ project_id: string | null; project_owner: string | null }>(
    `SELECT r.project_id,p.owner_user_id AS project_owner FROM run r
     JOIN conversation c ON c.id=r.conversation_id AND c.user_id=r.user_id
     JOIN app_user u ON u.id=r.user_id LEFT JOIN cert_project p ON p.id=r.project_id
     WHERE r.id=$1 AND r.user_id=$2 AND u.status='active'`,
    [runId, actor.userId],
  );
  const row = found.rows[0];
  if (
    !row ||
    !authorize(actor, 'conversation.write', {
      projectId: row.project_id,
      ownerUserId: actor.userId,
    }) ||
    (row.project_id &&
      !authorize(actor, 'project.read', {
        projectId: row.project_id,
        ownerUserId: row.project_owner,
      }))
  )
    throw unavailable();
}

/** 必须由已认证的接口层调用，并在独立自动提交语句中发出，不能藏在等待工具锁的事务里。 */
export async function notifyRunStop(pool: Pool, runId: string, userId: string) {
  const payload = runControlNotificationSchema.parse({ version: 1, action: 'stop', runId, userId });
  await pool.query('SELECT pg_notify($1,$2)', [RUN_CONTROL_CHANNEL, JSON.stringify(payload)]);
}

export async function stopRunVerifications(
  db: Database,
  {
    runId,
    conversationId,
    userId,
    roomId,
  }: { runId: string; conversationId: string; userId: string; roomId?: string },
) {
  await db.query(
    `UPDATE external_model_conversation c SET stopped_by=$3,state='discussing',updated_at=clock_timestamp()
     FROM verification_link l WHERE l.room_id=c.id AND l.kind='agent'
       AND l.run_id=$1 AND l.conversation_id=$2 AND l.requester=$3
       AND ($4::uuid IS NULL OR c.id=$4)
       AND c.state<>'completed' AND c.stopped_by IS NULL`,
    [runId, conversationId, userId, roomId ?? null],
  );
}

export async function stopOwnedRun(tx: PoolClient, actor: BrowserIdentity, runId: string) {
  const run = await lockOwnedRun(tx, runId, actor.userId);
  await authorizeRunStop(tx, actor, runId);
  if (!['queued', 'running', 'waiting'].includes(run.status))
    return runStopResultSchema.parse({ runId, status: run.status, changed: false });
  await tx.query(
    `UPDATE run SET status='stopped',finished_at=COALESCE(finished_at,CURRENT_TIMESTAMP),
     lease_owner=NULL,lease_expires_at=NULL,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
    [runId],
  );
  await stopRunVerifications(tx, {
    runId,
    conversationId: run.conversation_id,
    userId: actor.userId,
  });
  await cancelVerificationWaitsTx(tx, runId, actor.userId);
  await stopReviewVerificationTx(tx, runId, run.conversation_id, actor.userId);
  await cancelGoalWaitTx(tx, runId);
  await finishGoalWakeTx(tx, runId, false);
  await tx.query(
    `UPDATE run_continuation SET state='blocked',reason_code='CONTINUATION_STOPPED',
     version=version+1,finished_at=clock_timestamp(),updated_at=clock_timestamp()
     WHERE run_id=$1 AND state NOT IN ('blocked','completed')`,
    [runId],
  );
  await tx.query(
    "INSERT INTO audit_log(actor_user_id,actor_kind,action,target_type,target_id) VALUES($1,'browser','run.stop_requested','run',$2)",
    [actor.userId, runId],
  );
  return runStopResultSchema.parse({ runId, status: 'stopped', changed: true });
}
