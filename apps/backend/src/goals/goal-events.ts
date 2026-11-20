import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { goalControlInputSchema, type BrowserIdentity } from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { authorize } from '../auth/authorization.js';
import { appendConversationMessageTx } from '../conversations/storage.js';

type AwaitedSource = 'timer' | 'document' | 'manual';
type Query = Pick<PoolClient, 'query'>;
const waitingStatus = {
  timer: 'waiting_external',
  document: 'waiting_materials',
  manual: 'waiting_decision',
} as const;
const inactive = "('waiting_materials','waiting_external','waiting_decision')";
const unavailable = () =>
  new AppError(409, 'GOAL_CONTROL_CONFLICT', '目标状态或方向已更新，请刷新后再处理。');

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

export async function parkGoalWaitTx(db: Query, waitId: string, goalId: string, runId: string) {
  const wait = (
    await db.query<{ source: AwaitedSource }>(
      `SELECT source FROM goal_wait
    WHERE id=$1 AND goal_id=$2 AND run_id=$3 AND responded_at IS NULL AND cancelled_at IS NULL`,
      [waitId, goalId, runId],
    )
  ).rows[0];
  if (!wait) throw unavailable();
  const changed = await db.query(
    "UPDATE goal SET status=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND status='active'",
    [goalId, waitingStatus[wait.source]],
  );
  if (!changed.rowCount) throw unavailable();
}

export async function cancelGoalWaitTx(db: Query, runId: string) {
  await db.query(
    `UPDATE goal_wait SET cancelled_at=clock_timestamp()
    WHERE run_id=$1 AND responded_at IS NULL AND cancelled_at IS NULL`,
    [runId],
  );
}

export async function recordGoalEvent(
  db: Query,
  goalId: string,
  source: AwaitedSource,
  sourceKey: string,
) {
  const result = await db.query<{ id: string }>(
    `INSERT INTO goal_event(goal_id,source,source_key)
    VALUES($1,$2,$3) ON CONFLICT(source,source_key) DO NOTHING RETURNING id`,
    [goalId, source, sourceKey],
  );
  return result.rows[0]?.id ?? null;
}

export async function recordDocumentGoalEvent(db: Query, documentId: string, version: number) {
  const key = `${documentId}:${version}`;
  await db.query(
    `INSERT INTO goal_event(goal_id,source,source_key)
    SELECT w.goal_id,'document',$2::varchar FROM goal_wait w JOIN goal g ON g.id=w.goal_id
    JOIN document d ON d.id=$1 AND d.project_id=g.project_id
    WHERE w.source='document' AND w.source_key=$2 AND w.cancelled_at IS NULL AND w.responded_at IS NULL
    ORDER BY w.created_at,w.id LIMIT 1 ON CONFLICT(source,source_key) DO NOTHING`,
    [documentId, key],
  );
}

export async function scanGoalEvents(pool: Pool) {
  await pool.query(`UPDATE goal_wait w SET cancelled_at=clock_timestamp() FROM run r
    WHERE r.id=w.run_id AND r.status IN ('stopped','failed','budget_exhausted') AND w.cancelled_at IS NULL AND w.responded_at IS NULL`);
  await pool.query(`UPDATE goal SET status='active',version=version+1,updated_at=clock_timestamp()
    WHERE status IN ${inactive} AND EXISTS(SELECT 1 FROM goal_wait prior WHERE prior.goal_id=goal.id AND prior.cancelled_at IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM goal_wait open_wait WHERE open_wait.goal_id=goal.id AND open_wait.cancelled_at IS NULL AND open_wait.responded_at IS NULL)`);
  await pool.query(`INSERT INTO goal_event(goal_id,source,source_key)
    SELECT w.goal_id,'timer',w.source_key FROM goal_wait w WHERE w.source='timer'
      AND w.due_at<=clock_timestamp() AND w.responded_at IS NULL AND w.cancelled_at IS NULL
    ON CONFLICT(source,source_key) DO NOTHING`);
  const eligible = await pool.query<{
    event_id: string;
    wait_id: string;
    goal_id: string;
    owner_user_id: string;
    previous_run_id: string;
  }>(
    `SELECT e.id AS event_id,w.id AS wait_id,e.goal_id,g.owner_user_id,w.run_id AS previous_run_id
     FROM goal_event e JOIN goal_wait w ON w.goal_id=e.goal_id AND w.source=e.source AND w.source_key=e.source_key
     JOIN goal g ON g.id=e.goal_id AND g.status IN ${inactive}
     WHERE e.state='pending' AND w.cancelled_at IS NULL AND w.responded_at IS NULL
     ORDER BY e.created_at,e.id LIMIT 40`,
  );
  for (const candidate of eligible.rows) {
    await transaction(pool, async (db) => {
      if (
        !(
          await db.query("SELECT id FROM app_user WHERE id=$1 AND status='active' FOR SHARE", [
            candidate.owner_user_id,
          ])
        ).rowCount
      )
        return;
      const goal = (
        await db.query<{ project_id: string; direction_version: number; project_type: string }>(
          `SELECT g.project_id,g.direction_version,p.project_type FROM goal g JOIN cert_project p ON p.id=g.project_id
         WHERE g.id=$1 AND g.owner_user_id=$2 AND g.status IN ${inactive} FOR UPDATE OF g`,
          [candidate.goal_id, candidate.owner_user_id],
        )
      ).rows[0];
      if (
        !goal ||
        (
          await db.query("SELECT 1 FROM goal_event WHERE goal_id=$1 AND state='queued' LIMIT 1", [
            candidate.goal_id,
          ])
        ).rowCount
      )
        return;
      const previous = (
        await db.query<{ status: string; lease_owner: string | null; max_data_level: string }>(
          'SELECT status,lease_owner,max_data_level FROM run WHERE id=$1 FOR UPDATE',
          [candidate.previous_run_id],
        )
      ).rows[0];
      if (previous?.status !== 'waiting' || previous.lease_owner) return;
      const event = (
        await db.query<{ source: AwaitedSource; source_key: string }>(
          "SELECT source,source_key FROM goal_event WHERE id=$1 AND state='pending' FOR UPDATE",
          [candidate.event_id],
        )
      ).rows[0];
      if (!event) return;
      const wait = (
        await db.query<{ reason: string }>(
          `SELECT reason FROM goal_wait WHERE id=$1 AND cancelled_at IS NULL AND responded_at IS NULL FOR UPDATE`,
          [candidate.wait_id],
        )
      ).rows[0];
      if (!wait) return;
      const conversationId = randomUUID();
      const runId = randomUUID();
      const agent = goal.project_type === 'maintenance' ? 'maintenance' : 'registration';
      const title = { document: '资料到达', timer: '定时已到', manual: '人工确认' }[event.source];
      await db.query(
        `INSERT INTO conversation(id,project_id,user_id,goal_id,title,permission_mode,agent_code,max_data_level)
        VALUES($1,$2,$3,$4,$5,'ask',$6,$7)`,
        [
          conversationId,
          goal.project_id,
          candidate.owner_user_id,
          candidate.goal_id,
          `${title}后继续`,
          agent,
          previous.max_data_level,
        ],
      );
      await db.query(
        `INSERT INTO run(id,conversation_id,user_id,project_id,goal_id,direction_version,trigger_type,status,max_data_level)
        VALUES($1,$2,$3,$4,$5,$6,'wakeup','queued',$7)`,
        [
          runId,
          conversationId,
          candidate.owner_user_id,
          goal.project_id,
          candidate.goal_id,
          goal.direction_version,
          previous.max_data_level,
        ],
      );
      await db.query('UPDATE conversation SET current_run_id=$2 WHERE id=$1', [
        conversationId,
        runId,
      ]);
      await db.query(
        "UPDATE goal SET status='active',version=version+1,updated_at=clock_timestamp() WHERE id=$1",
        [candidate.goal_id],
      );
      await db.query('UPDATE goal_wait SET responded_at=clock_timestamp() WHERE id=$1', [
        candidate.wait_id,
      ]);
      await db.query(
        "UPDATE run SET status='completed',version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND status='waiting'",
        [candidate.previous_run_id],
      );
      await db.query("UPDATE goal_event SET state='queued',wake_run_id=$2 WHERE id=$1", [
        candidate.event_id,
        runId,
      ]);
      await appendConversationMessageTx(db, {
        runId,
        userId: candidate.owner_user_id,
        requestKey: candidate.event_id,
        message: {
          role: 'user',
          content: `系统唤醒通知。${title}，参考编号 ${event.source_key}。待继续事项为 ${wait.reason}。先核对项目资料，保持审核与批准要求。`,
        },
      });
    });
  }
}

export async function finishGoalWakeTx(db: Query, runId: string, complete: boolean) {
  await db.query(
    `UPDATE goal_event SET state=$2,processed_at=clock_timestamp()
    WHERE wake_run_id=$1 AND state='queued' AND source<>'verification'`,
    [runId, complete ? 'completed' : 'cancelled'],
  );
}

export async function scanReviewDecisionEvents(pool: Pool) {
  const found = await pool.query<{
    event_id: string;
    goal_id: string;
    run_id: string;
    user_id: string;
    conversation_id: string;
    project_id: string;
    card_id: string;
    action: string;
  }>(
    `SELECT e.id AS event_id,e.goal_id,r.id AS run_id,r.user_id,r.conversation_id,r.project_id,d.card_id,d.action
     FROM goal_event e JOIN review_decision d ON d.id::text=e.source_key JOIN review_card c ON c.id=d.card_id
     JOIN run r ON r.id=c.run_id AND r.goal_id=e.goal_id JOIN goal g ON g.id=e.goal_id AND g.status='active'
     WHERE e.source='review_decision' AND e.state='pending' ORDER BY e.created_at,e.id LIMIT 40`,
  );
  for (const row of found.rows)
    await transaction(pool, async (db) => {
      if (
        !(
          await db.query("SELECT id FROM app_user WHERE id=$1 AND status='active' FOR SHARE", [
            row.user_id,
          ])
        ).rowCount
      )
        return;
      const goal = (
        await db.query<{ direction_version: number }>(
          "SELECT direction_version FROM goal WHERE id=$1 AND project_id=$2 AND status='active' FOR UPDATE",
          [row.goal_id, row.project_id],
        )
      ).rows[0];
      if (
        !goal ||
        (
          await db.query("SELECT 1 FROM goal_event WHERE goal_id=$1 AND state='queued' LIMIT 1", [
            row.goal_id,
          ])
        ).rowCount
      )
        return;
      const conversation = await db.query(
        `SELECT id FROM conversation WHERE id=$1 AND user_id=$2 AND project_id=$3 AND goal_id=$4 AND status='active' FOR UPDATE`,
        [row.conversation_id, row.user_id, row.project_id, row.goal_id],
      );
      if (!conversation.rowCount) return;
      const prior = (
        await db.query<{ status: string; lease_owner: string | null; max_data_level: string }>(
          'SELECT status,lease_owner,max_data_level FROM run WHERE id=$1 FOR UPDATE',
          [row.run_id],
        )
      ).rows[0];
      if (!prior || prior.lease_owner || !['completed', 'stopped'].includes(prior.status)) return;
      if (
        (
          await db.query(
            "SELECT 1 FROM run WHERE conversation_id=$1 AND status IN ('running','queued','waiting') LIMIT 1",
            [row.conversation_id],
          )
        ).rowCount
      )
        return;
      if (
        !(
          await db.query("SELECT id FROM goal_event WHERE id=$1 AND state='pending' FOR UPDATE", [
            row.event_id,
          ])
        ).rowCount
      )
        return;
      const runId = randomUUID();
      await db.query(
        `INSERT INTO run(id,conversation_id,user_id,project_id,goal_id,direction_version,trigger_type,status,max_data_level)
      SELECT $1,c.id,$3,$4,$5,$6,'wakeup','queued',GREATEST(c.max_data_level,$7::document_data_level)
      FROM conversation c WHERE c.id=$2`,
        [
          runId,
          row.conversation_id,
          row.user_id,
          row.project_id,
          row.goal_id,
          goal.direction_version,
          prior.max_data_level,
        ],
      );
      await db.query('UPDATE conversation SET current_run_id=$2 WHERE id=$1', [
        row.conversation_id,
        runId,
      ]);
      await db.query("UPDATE goal_event SET state='queued',wake_run_id=$2 WHERE id=$1", [
        row.event_id,
        runId,
      ]);
      await appendConversationMessageTx(db, {
        runId,
        userId: row.user_id,
        requestKey: row.event_id,
        message: {
          role: 'user',
          content: `系统续跑通知。审核卡 ${row.card_id} 已由人${row.action === 'approved' ? '通过' : '退回'}。请核对原对话与审核记录，说明需继续处理的事项。禁止代办人工审批或对外发送。`,
        },
      });
    });
}

export async function controlGoal(
  pool: Pool,
  actor: BrowserIdentity,
  goalId: string,
  input: unknown,
) {
  const command = goalControlInputSchema.safeParse(input);
  if (!command.success) throw unavailable();
  return transaction(pool, async (db) => {
    if (
      !(
        await db.query(
          `SELECT s.id FROM web_session s JOIN app_user u ON u.id=s.user_id
      WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
      AND u.status='active' FOR SHARE OF s,u`,
          [actor.sessionId, actor.userId],
        )
      ).rowCount
    )
      throw unavailable();
    const current = (
      await db.query<{
        project_id: string;
        owner_user_id: string;
        status: string;
        version: number;
        direction_version: number;
      }>(
        `SELECT g.project_id,p.owner_user_id,g.status,g.version,g.direction_version FROM goal g JOIN cert_project p ON p.id=g.project_id
       WHERE g.id=$1 FOR UPDATE OF g`,
        [goalId],
      )
    ).rows[0];
    if (
      !current ||
      !authorize(actor, 'project.write', {
        projectId: current.project_id,
        ownerUserId: current.owner_user_id,
      })
    )
      throw unavailable();
    if (current.version !== command.data.expectedVersion) throw unavailable();
    if (
      command.data.action === 'takeover' &&
      ![
        'active',
        'waiting_external',
        'waiting_materials',
        'waiting_decision',
        'pending_review',
      ].includes(current.status)
    )
      throw unavailable();
    if (command.data.action === 'handoff' && current.status !== 'human_controlled')
      throw unavailable();
    const wait = (
      await db.query<{ source: AwaitedSource }>(
        'SELECT source FROM goal_wait WHERE goal_id=$1 AND responded_at IS NULL AND cancelled_at IS NULL',
        [goalId],
      )
    ).rows[0];
    const next =
      command.data.action === 'takeover'
        ? 'human_controlled'
        : wait
          ? waitingStatus[wait.source]
          : 'active';
    const direction = current.direction_version + 1;
    await db.query(
      'INSERT INTO goal_direction(goal_id,version,note,author_user_id) VALUES($1,$2,$3,$4)',
      [goalId, direction, command.data.note, actor.userId],
    );
    await db.query(
      'UPDATE goal SET status=$2,direction_version=$3,version=version+1,updated_at=clock_timestamp() WHERE id=$1',
      [goalId, next, direction],
    );
    await db.query(
      "INSERT INTO audit_log(actor_user_id,actor_kind,action,target_type,target_id) VALUES($1,'browser',$2,'goal',$3)",
      [actor.userId, `goal.${command.data.action}`, goalId],
    );
    return { goalId, status: next, version: current.version + 1, directionVersion: direction };
  });
}
