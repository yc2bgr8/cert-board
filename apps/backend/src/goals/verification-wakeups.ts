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

const readyResult = `(c.state='completed' OR
  (l.timeout_requested_at IS NOT NULL AND
   (c.state='paused' OR l.timeout_requested_at<=clock_timestamp()-interval '5 minutes')))`;

export async function advanceVerificationDeadlines(pool: Pool) {
  await pool.query(`WITH overdue AS (
    SELECT l.room_id FROM verification_link l JOIN external_model_conversation c ON c.id=l.room_id
    WHERE l.deadline_at<=clock_timestamp() AND l.timeout_requested_at IS NULL
      AND c.state<>'completed' AND (l.auto_resume OR EXISTS(
        SELECT 1 FROM verification_wait w WHERE w.room_id=l.room_id AND w.state='waiting'))
      AND NOT EXISTS(SELECT 1 FROM goal_event e WHERE e.source='verification' AND e.source_key=l.room_id::text)
    ORDER BY l.deadline_at,l.room_id LIMIT 40 FOR UPDATE OF c SKIP LOCKED
  ), clocked AS (
    UPDATE verification_link l SET timeout_requested_at=clock_timestamp()
    FROM overdue WHERE l.room_id=overdue.room_id AND l.timeout_requested_at IS NULL
    RETURNING l.room_id,l.requester
  ), stopped AS (
    UPDATE external_model_conversation c SET stopped_by=COALESCE(c.stopped_by,clocked.requester),
      state='discussing',updated_at=clock_timestamp() FROM clocked WHERE c.id=clocked.room_id AND c.state<>'completed'
    RETURNING c.id
  )
  INSERT INTO audit_log(actor_kind,action,target_type,target_id)
    SELECT 'system','verification.deadline_stop','external_model_conversation',id FROM stopped`);
}

async function auditWake(db: PoolClient, roomId: string, duplicate: boolean) {
  await db.query(
    `INSERT INTO audit_log(actor_kind,action,target_type,target_id)
    VALUES('system',$1,'external_model_conversation',$2)`,
    [duplicate ? 'verification.wakeup_duplicate' : 'verification.wakeup_queued', roomId],
  );
}

export async function scanVerificationNotices(pool: Pool) {
  await pool.query(`WITH unavailable AS (
    SELECT l.room_id,g.id AS goal_id,COALESCE(e.wake_run_id,CASE WHEN l.kind='agent' THEN r.id END) AS pending_run,
      COALESCE(owner.id,(SELECT m.id FROM app_user m WHERE m.status='active' AND m.is_management ORDER BY m.id LIMIT 1)) AS recipient
    FROM verification_link l JOIN external_model_conversation c ON c.id=l.room_id
    JOIN run r ON r.id=l.run_id JOIN goal g ON g.id=r.goal_id
    JOIN conversation t ON t.id=l.conversation_id
    JOIN app_user original ON original.id=r.user_id JOIN app_user requester ON requester.id=l.requester
    LEFT JOIN app_user owner ON owner.id=g.owner_user_id AND owner.status='active'
    LEFT JOIN goal_event e ON e.source='verification' AND e.source_key=l.room_id::text
    LEFT JOIN verification_wait paused ON paused.room_id=l.room_id
    WHERE ${readyResult}
      AND (l.auto_resume OR EXISTS(SELECT 1 FROM verification_wait w WHERE w.room_id=l.room_id AND w.state IN ('waiting','queued')))
      AND (original.status<>'active' OR requester.status<>'active' OR t.status<>'active')
      AND (e.id IS NULL OR (e.state IN ('queued','cancelled') AND paused.state IN ('queued','cancelled') AND paused.receipt IS NULL))
      AND NOT EXISTS(SELECT 1 FROM verification_notice n WHERE n.room_id=l.room_id AND n.kind='blocked')
    ORDER BY l.created_at,l.room_id LIMIT 40
  ), handled AS (
    INSERT INTO goal_event(goal_id,source,source_key,state,processed_at)
    SELECT goal_id,'verification',room_id::text,'cancelled',clock_timestamp() FROM unavailable WHERE recipient IS NOT NULL
    ON CONFLICT(source,source_key) DO UPDATE SET state='cancelled',processed_at=clock_timestamp()
      WHERE goal_event.state IN ('queued','cancelled') RETURNING source_key
  ), cancelled AS (
    UPDATE verification_wait w SET state='cancelled',updated_at=clock_timestamp() FROM handled
    WHERE w.room_id::text=handled.source_key AND w.state IN ('waiting','queued')
  ), stopped AS (
    UPDATE run r SET status='stopped',finished_at=COALESCE(r.finished_at,clock_timestamp()),
      lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp(),version=r.version+1
    FROM unavailable u JOIN handled h ON h.source_key=u.room_id::text
    WHERE r.id=u.pending_run AND r.status IN ('waiting','queued')
      AND (r.lease_owner IS NULL OR r.lease_expires_at<=clock_timestamp())
  ), notices AS (
    INSERT INTO verification_notice(room_id,recipient_user_id,kind,position)
    SELECT u.room_id,u.recipient,'blocked',0 FROM unavailable u JOIN handled h ON h.source_key=u.room_id::text
    ON CONFLICT(room_id,kind,position) DO NOTHING RETURNING room_id
  )
  INSERT INTO audit_log(actor_kind,action,target_type,target_id)
  SELECT 'system','verification.wakeup_blocked','external_model_conversation',room_id FROM notices`);
  await pool.query(`WITH notices AS (
    INSERT INTO verification_notice(room_id,recipient_user_id,kind,position)
    SELECT l.room_id,l.requester,'late',c.next_position-1
    FROM verification_wait w JOIN verification_link l ON l.room_id=w.room_id
    JOIN external_model_conversation c ON c.id=w.room_id
    JOIN app_user u ON u.id=l.requester AND u.status='active'
    WHERE w.receipt IS NOT NULL AND c.state='completed' AND c.next_position-1>w.delivered_conclusion_position
      AND NOT EXISTS(SELECT 1 FROM verification_notice n WHERE n.room_id=w.room_id AND n.kind='late' AND n.position=c.next_position-1)
    ORDER BY c.updated_at,c.id LIMIT 40 ON CONFLICT(room_id,kind,position) DO NOTHING RETURNING room_id
  )
  INSERT INTO audit_log(actor_kind,action,target_type,target_id)
  SELECT 'system','verification.wakeup_late','external_model_conversation',room_id FROM notices`);
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
    `UPDATE verification_wait w SET state='running',updated_at=clock_timestamp()
     WHERE w.room_id=$1 AND w.run_id=$2 AND w.user_id=$3 AND w.state='queued'
      AND EXISTS(SELECT 1 FROM verification_link l JOIN app_user u ON u.id=l.requester AND u.status='active'
        JOIN conversation t ON t.id=l.conversation_id AND t.status='active' WHERE l.room_id=w.room_id)`,
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
     JOIN verification_link l ON l.room_id=w.room_id
     JOIN goal g ON g.id=r.goal_id AND g.status='active'
     JOIN app_user u ON u.id=w.user_id AND u.status='active'
     JOIN conversation t ON t.id=w.conversation_id AND t.user_id=w.user_id AND t.status='active'
     WHERE w.state='waiting' AND ${readyResult} AND r.status='waiting'
       AND (r.lease_owner IS NULL OR r.lease_expires_at<=clock_timestamp())
     ORDER BY w.created_at,w.room_id LIMIT 40`,
  );
  for (const candidate of ready.rows) {
    await transaction(pool, async (db) => {
      const live = await db.query(
        "SELECT id FROM app_user WHERE id=$1 AND status='active' FOR SHARE",
        [candidate.user_id],
      );
      if (!live.rowCount) return;
      const active = await db.query<{ direction_version: number }>(
        "SELECT direction_version FROM goal WHERE id=$1 AND status='active' FOR UPDATE",
        [candidate.goal_id],
      );
      if (!active.rowCount) return;
      const conversation = await db.query(
        `SELECT id FROM conversation WHERE id=$1 AND user_id=$2 AND status='active'
        AND (current_run_id IS NULL OR current_run_id=$3) FOR UPDATE`,
        [candidate.conversation_id, candidate.user_id, candidate.run_id],
      );
      if (!conversation.rowCount) return;
      const run = await lockOwnedRun(db, candidate.run_id, candidate.user_id);
      if (run.status !== 'waiting' || (run.lease_expires_at && run.lease_expires_at > new Date())) {
        if (
          await db
            .query("SELECT 1 FROM goal_event WHERE source='verification' AND source_key=$1", [
              candidate.room_id,
            ])
            .then((x) => x.rowCount)
        )
          await auditWake(db, candidate.room_id, true);
        return;
      }
      if (await occupied(db, candidate.goal_id)) return;
      const original = (
        await db.query<{ direction_version: number }>(
          'SELECT direction_version FROM run WHERE id=$1',
          [candidate.run_id],
        )
      ).rows[0]!;
      const checked = await db.query<{ fallback: boolean; position: number; conclusion: unknown }>(
        `SELECT (c.state<>'completed' OR NOT EXISTS(SELECT 1 FROM verification_post p WHERE p.room_id=c.id AND p.type='model')) AS fallback,
          c.next_position-1 AS position,CASE WHEN c.state='completed' THEN c.conclusion END AS conclusion
        FROM verification_wait w JOIN external_model_conversation c ON c.id=w.room_id
        JOIN verification_link l ON l.room_id=w.room_id
        WHERE w.room_id=$1 AND w.run_id=$2 AND w.state='waiting' AND ${readyResult} FOR UPDATE OF w,c`,
        [candidate.room_id, candidate.run_id],
      );
      if (!checked.rowCount) return;
      const inserted = await db.query(
        `INSERT INTO goal_event(goal_id,source,source_key,state,wake_run_id)
        VALUES($1,'verification',$2,'queued',$3) ON CONFLICT(source,source_key) DO NOTHING`,
        [candidate.goal_id, candidate.room_id, candidate.run_id],
      );
      await auditWake(db, candidate.room_id, !inserted.rowCount);
      if (!inserted.rowCount) return;
      await db.query(
        `UPDATE verification_wait SET state='queued',fallback=$2,delivered_conclusion_position=$3,conclusion=$4,direction_from=$5,
         updated_at=clock_timestamp() WHERE room_id=$1`,
        [
          candidate.room_id,
          checked.rows[0]!.fallback,
          checked.rows[0]!.position,
          checked.rows[0]!.conclusion,
          original.direction_version,
        ],
      );
      await db.query(
        "UPDATE run SET status='queued',direction_version=$2,lease_owner=NULL,lease_expires_at=NULL,finished_at=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=$1",
        [candidate.run_id, active.rows[0]!.direction_version],
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
      JOIN external_model_conversation c ON c.id=l.room_id
      JOIN run r ON r.id=l.run_id AND r.conversation_id=l.conversation_id
      JOIN goal g ON g.id=r.goal_id AND g.status='active'
      JOIN app_user u ON u.id=r.user_id AND u.status='active'
      JOIN app_user requester ON requester.id=l.requester AND requester.status='active'
      JOIN conversation t ON t.id=l.conversation_id AND t.status='active'
      WHERE l.kind='review' AND l.auto_resume AND ${readyResult} AND r.status NOT IN ('failed','budget_exhausted')
        AND (r.status<>'stopped' OR EXISTS(SELECT 1 FROM review_card card WHERE card.id=l.review_id AND card.status='rejected'))
        AND (r.lease_owner IS NULL OR r.lease_expires_at<=clock_timestamp())
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
      if (!active) return;
      const conversation = await db.query(
        `SELECT id FROM conversation WHERE id=$1 AND user_id=$2 AND project_id=$3 AND goal_id=$4 AND status='active' FOR UPDATE`,
        [next.conversation_id, next.user_id, next.project_id, next.goal_id],
      );
      if (!conversation.rowCount) return;
      const old = await lockOwnedRun(db, next.run_id, next.user_id);
      if (
        ['failed', 'budget_exhausted'].includes(old.status) ||
        (old.lease_expires_at && old.lease_expires_at > new Date())
      )
        return;
      if (
        (
          await db.query("SELECT 1 FROM goal_event WHERE source='verification' AND source_key=$1", [
            next.room_id,
          ])
        ).rowCount
      ) {
        await auditWake(db, next.room_id, true);
        return;
      }
      if (await occupied(db, next.goal_id)) return;
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
      const incoming = (
        await db.query<{
          fallback: boolean;
          position: number;
          conclusion: unknown;
          direction_version: number;
        }>(
          `SELECT (c.state<>'completed' OR NOT EXISTS(SELECT 1 FROM verification_post p WHERE p.room_id=c.id AND p.type='model')) AS fallback,
          c.next_position-1 AS position,CASE WHEN c.state='completed' THEN c.conclusion END AS conclusion,r.direction_version
         FROM verification_link l JOIN external_model_conversation c ON c.id=l.room_id
         JOIN run r ON r.id=l.run_id JOIN app_user u ON u.id=l.requester AND u.status='active'
         JOIN review_card card ON card.id=l.review_id
         WHERE l.room_id=$1 AND ${readyResult} AND (r.status<>'stopped' OR card.status='rejected') FOR UPDATE OF c`,
          [next.room_id],
        )
      ).rows[0];
      if (!incoming) return;
      const registered = await db.query(
        `INSERT INTO goal_event(goal_id,source,source_key)
        VALUES($1,'verification',$2) ON CONFLICT(source,source_key) DO NOTHING`,
        [next.goal_id, next.room_id],
      );
      await auditWake(db, next.room_id, !registered.rowCount);
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
        `INSERT INTO verification_wait(room_id,run_id,conversation_id,user_id,state,fallback,delivered_conclusion_position,conclusion,direction_from)
        VALUES($1,$2,$3,$4,'queued',$5,$6,$7,$8)`,
        [
          next.room_id,
          runId,
          next.conversation_id,
          next.user_id,
          incoming.fallback,
          incoming.position,
          incoming.conclusion,
          incoming.direction_version,
        ],
      );
      await db.query(
        "UPDATE goal_event SET state='queued',wake_run_id=$2 WHERE source='verification' AND source_key=$1",
        [next.room_id, runId],
      );
      await db.query('UPDATE conversation SET current_run_id=$2 WHERE id=$1', [
        next.conversation_id,
        runId,
      ]);
      const waitingMessages = (
        await db.query<{ request_key: string; content: string }>(
          `SELECT s.request_key,s.content FROM run_steering_message s
         WHERE s.run_id=$1 AND s.conversation_id=$2 AND s.user_id=$3 AND s.delivered_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM conversation_message m WHERE m.conversation_id=s.conversation_id AND m.request_key=s.request_key)
        ORDER BY s.created_at,s.id LIMIT 30`,
          [next.run_id, next.conversation_id, next.user_id],
        )
      ).rows;
      for (const saved of waitingMessages)
        await appendConversationMessageTx(db, {
          runId,
          userId: next.user_id,
          requestKey: saved.request_key,
          message: { role: 'user', content: saved.content },
        });
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
