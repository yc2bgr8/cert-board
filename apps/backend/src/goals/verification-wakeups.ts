import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { AppError } from '../api/errors.js';
import { lockOwnedRun } from '../runs/lock.js';
import { appendConversationMessageTx } from '../conversations/storage.js';

type Wait = {
  roomId: string;
  runId: string;
  conversationId: string;
  userId: string;
  callId: string | null;
  state: string;
};
type DirectWait = Omit<Wait, 'state' | 'callId'> & { callId: string };
const fields =
  'room_id AS "roomId",run_id AS "runId",conversation_id AS "conversationId",user_id AS "userId",call_id AS "callId",state';
const missing = () =>
  new AppError(
    409,
    'VERIFICATION_RESUME_UNAVAILABLE',
    '核实续跑状态无法确认，请在原对话查看核实结果。',
  );

async function transaction<T>(pool: Pool, work: (db: PoolClient) => Promise<T>) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await work(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

export async function registerVerificationWaitTx(db: PoolClient, wait: DirectWait) {
  const result = await db.query(
    `INSERT INTO verification_wait(room_id,run_id,conversation_id,user_id,call_id)
     SELECT l.room_id,l.run_id,l.conversation_id,l.requester,$5::varchar FROM verification_link l
     WHERE l.room_id=$1 AND l.run_id=$2 AND l.conversation_id=$3 AND l.requester=$4 AND l.kind='agent'
     AND EXISTS(SELECT 1 FROM tool_invocation i WHERE i.run_id=l.run_id AND i.conversation_id=l.conversation_id
       AND i.user_id=l.requester AND i.call_id=$5 AND i.tool_name='consult_external_model' AND i.status='completed')
     ON CONFLICT(room_id) DO NOTHING`,
    [wait.roomId, wait.runId, wait.conversationId, wait.userId, wait.callId],
  );
  if (result.rowCount !== 1) throw missing();
}

export async function readVerificationWait(
  pool: Pool,
  roomId: string,
  runId: string,
  userId: string,
) {
  return (
    await pool.query<Wait>(
      `SELECT ${fields} FROM verification_wait WHERE room_id=$1 AND run_id=$2 AND user_id=$3`,
      [roomId, runId, userId],
    )
  ).rows[0];
}

export async function claimVerificationResume(pool: Pool, wait: Wait) {
  const updated = await pool.query(
    `UPDATE verification_wait SET state='running',updated_at=clock_timestamp()
     WHERE room_id=$1 AND run_id=$2 AND user_id=$3 AND state='queued'`,
    [wait.roomId, wait.runId, wait.userId],
  );
  if (updated.rowCount !== 1) throw missing();
}

export async function finishVerificationResumeTx(db: PoolClient, wait: Wait, completed: boolean) {
  const result = await db.query(
    `UPDATE verification_wait SET state=$2,updated_at=clock_timestamp()
     WHERE room_id=$1 AND run_id=$3 AND user_id=$4 AND state='running'`,
    [wait.roomId, completed ? 'finished' : 'cancelled', wait.runId, wait.userId],
  );
  if (result.rowCount)
    await db.query(
      `UPDATE goal_event SET state=$2,processed_at=clock_timestamp()
      WHERE source='verification' AND source_key=$1 AND wake_run_id=$3`,
      [wait.roomId, completed ? 'completed' : 'cancelled', wait.runId],
    );
}

export async function scanReadyVerificationWaits(pool: Pool) {
  const ready = await pool.query<{
    room_id: string;
    run_id: string;
    user_id: string;
    conversation_id: string;
    goal_id: string;
  }>(
    `SELECT w.room_id,w.run_id,w.conversation_id,w.user_id,r.goal_id FROM verification_wait w
     JOIN run r ON r.id=w.run_id AND r.user_id=w.user_id AND r.conversation_id=w.conversation_id
     JOIN external_model_conversation c ON c.id=w.room_id
     JOIN goal g ON g.id=r.goal_id AND g.status='active'
     WHERE w.state='waiting' AND c.state='completed' AND r.status='waiting' AND r.lease_owner IS NULL
     ORDER BY w.created_at,w.room_id LIMIT 40`,
  );
  for (const candidate of ready.rows) {
    await transaction(pool, async (db) => {
      const live = await db.query(
        "SELECT id FROM app_user WHERE id=$1 AND status='active' FOR SHARE",
        [candidate.user_id],
      );
      if (!live.rowCount) return;
      const active = await db.query(
        "SELECT id FROM goal WHERE id=$1 AND status='active' FOR UPDATE",
        [candidate.goal_id],
      );
      if (!active.rowCount) return;
      if (await occupied(db, candidate.goal_id)) return;
      const conversation = await db.query(
        `SELECT id FROM conversation WHERE id=$1 AND user_id=$2 AND status='active'
        AND (current_run_id IS NULL OR current_run_id=$3) FOR UPDATE`,
        [candidate.conversation_id, candidate.user_id, candidate.run_id],
      );
      if (!conversation.rowCount) return;
      const run = await lockOwnedRun(db, candidate.run_id, candidate.user_id);
      if (run.status !== 'waiting' || run.lease_owner) return;
      const checked = await db.query(
        `SELECT w.room_id FROM verification_wait w JOIN external_model_conversation c ON c.id=w.room_id
        WHERE w.room_id=$1 AND w.run_id=$2 AND w.state='waiting' AND c.state='completed' FOR UPDATE OF w`,
        [candidate.room_id, candidate.run_id],
      );
      if (!checked.rowCount) return;
      const inserted = await db.query(
        `INSERT INTO goal_event(goal_id,source,source_key,state,wake_run_id)
        VALUES($1,'verification',$2,'queued',$3) ON CONFLICT(source,source_key) DO NOTHING`,
        [candidate.goal_id, candidate.room_id, candidate.run_id],
      );
      if (!inserted.rowCount) return;
      await db.query(
        "UPDATE verification_wait SET state='queued',updated_at=clock_timestamp() WHERE room_id=$1",
        [candidate.room_id],
      );
      await db.query(
        "UPDATE run SET status='queued',finished_at=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=$1",
        [candidate.run_id],
      );
      await db.query('UPDATE conversation SET current_run_id=$2 WHERE id=$1', [
        candidate.conversation_id,
        candidate.run_id,
      ]);
    });
  }
}

export async function listVerificationResumes(pool: Pool) {
  return (
    await pool.query<Wait>(
      `SELECT ${fields} FROM verification_wait WHERE state='queued' ORDER BY created_at,room_id LIMIT 40`,
    )
  ).rows;
}

async function occupied(db: PoolClient, goalId: string) {
  return Boolean(
    (
      await db.query("SELECT 1 FROM goal_event WHERE goal_id=$1 AND state='queued' LIMIT 1", [
        goalId,
      ])
    ).rowCount,
  );
}

export async function scanReviewVerificationResults(pool: Pool) {
  const ready = await pool.query<{
    room_id: string;
    run_id: string;
    user_id: string;
    conversation_id: string;
    project_id: string;
    goal_id: string;
    review_id: string;
  }>(
    `SELECT l.room_id,l.run_id,l.conversation_id,r.user_id,r.project_id,r.goal_id,l.review_id FROM verification_link l
      JOIN external_model_conversation v ON v.id=l.room_id AND v.state='completed'
      JOIN run r ON r.id=l.run_id AND r.conversation_id=l.conversation_id
      JOIN goal g ON g.id=r.goal_id AND g.status='active'
      WHERE l.kind='review' AND l.auto_resume AND r.status NOT IN ('stopped','failed','budget_exhausted')
        AND NOT EXISTS(SELECT 1 FROM goal_event e WHERE e.source='verification' AND e.source_key=l.room_id::text)
      ORDER BY l.created_at,l.room_id LIMIT 40`,
  );
  for (const next of ready.rows) {
    await transaction(pool, async (db) => {
      if (
        !(
          await db.query("SELECT id FROM app_user WHERE id=$1 AND status='active' FOR SHARE", [
            next.user_id,
          ])
        ).rowCount
      )
        return;
      const active = (
        await db.query<{ direction_version: number }>(
          "SELECT direction_version FROM goal WHERE id=$1 AND project_id=$2 AND status='active' FOR UPDATE",
          [next.goal_id, next.project_id],
        )
      ).rows[0];
      if (!active || (await occupied(db, next.goal_id))) return;
      const conversation = await db.query(
        `SELECT id FROM conversation WHERE id=$1 AND user_id=$2 AND project_id=$3 AND goal_id=$4 AND status='active' FOR UPDATE`,
        [next.conversation_id, next.user_id, next.project_id, next.goal_id],
      );
      if (!conversation.rowCount) return;
      const old = await lockOwnedRun(db, next.run_id, next.user_id);
      if (['stopped', 'failed', 'budget_exhausted'].includes(old.status) || old.lease_owner) return;
      if (
        (
          await db.query(
            `SELECT 1 FROM run WHERE conversation_id=$1 AND
        (status IN ('queued','running') OR (status='waiting' AND id<>$2)) LIMIT 1`,
            [next.conversation_id, next.run_id],
          )
        ).rowCount
      )
        return;
      const registered = await db.query(
        `INSERT INTO goal_event(goal_id,source,source_key)
        VALUES($1,'verification',$2) ON CONFLICT(source,source_key) DO NOTHING`,
        [next.goal_id, next.room_id],
      );
      if (!registered.rowCount) return;
      const runId = randomUUID();
      await db.query(
        `INSERT INTO run(id,conversation_id,user_id,project_id,goal_id,direction_version,trigger_type,status,max_data_level)
        SELECT $1,c.id,$3,$4,$5,$6,'wakeup','queued',GREATEST(c.max_data_level,r.max_data_level)
        FROM conversation c JOIN run r ON r.id=$7 WHERE c.id=$2`,
        [
          runId,
          next.conversation_id,
          next.user_id,
          next.project_id,
          next.goal_id,
          active.direction_version,
          next.run_id,
        ],
      );
      await db.query(
        `INSERT INTO verification_wait(room_id,run_id,conversation_id,user_id,state)
        VALUES($1,$2,$3,$4,'queued')`,
        [next.room_id, runId, next.conversation_id, next.user_id],
      );
      await db.query(
        "UPDATE goal_event SET state='queued',wake_run_id=$2 WHERE source='verification' AND source_key=$1",
        [next.room_id, runId],
      );
      await db.query('UPDATE conversation SET current_run_id=$2 WHERE id=$1', [
        next.conversation_id,
        runId,
      ]);
      await appendConversationMessageTx(db, {
        runId,
        userId: next.user_id,
        requestKey: next.room_id,
        message: {
          role: 'user',
          content: `系统续跑通知。审核卡 ${next.review_id} 发起的核实已结束。请依据核实结果继续核对并报告受影响事项。审核决定只接受浏览器操作。`,
        },
      });
    });
  }
}

export async function cancelVerificationWaitsTx(db: PoolClient, runId: string, userId: string) {
  const cancelled = await db.query<{ room_id: string }>(
    `UPDATE verification_wait SET state='cancelled',updated_at=clock_timestamp()
     WHERE run_id=$1 AND user_id=$2 AND state IN ('waiting','queued','running') RETURNING room_id`,
    [runId, userId],
  );
  if (cancelled.rowCount)
    await db.query(
      `UPDATE goal_event SET state='cancelled',processed_at=clock_timestamp()
    WHERE source='verification' AND source_key=ANY($1::text[]) AND wake_run_id=$2`,
      [cancelled.rows.map(({ room_id }) => room_id), runId],
    );
}

export async function stopReviewVerificationTx(
  db: PoolClient,
  runId: string,
  conversationId: string,
  userId: string,
) {
  await db.query(
    `INSERT INTO goal_event(goal_id,source,source_key,state,processed_at)
    SELECT r.goal_id,'verification',l.room_id::text,'cancelled',clock_timestamp() FROM verification_link l
    JOIN run r ON r.id=l.run_id AND r.conversation_id=l.conversation_id
    WHERE l.run_id=$1 AND l.conversation_id=$2 AND r.user_id=$3 AND r.goal_id IS NOT NULL AND l.kind='review' AND l.auto_resume
    ON CONFLICT(source,source_key) DO NOTHING`,
    [runId, conversationId, userId],
  );
  await db.query(
    `UPDATE external_model_conversation c SET stopped_by=$3,state='discussing',updated_at=clock_timestamp()
    FROM verification_link l JOIN run r ON r.id=l.run_id AND r.conversation_id=l.conversation_id
    WHERE c.id=l.room_id AND l.run_id=$1 AND l.conversation_id=$2 AND r.user_id=$3 AND l.kind='review' AND l.auto_resume
      AND c.state<>'completed' AND c.stopped_by IS NULL`,
    [runId, conversationId, userId],
  );
}
