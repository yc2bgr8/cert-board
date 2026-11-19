import type { Pool } from 'pg';

const service = 'deadline-scan';
const staleAfterMs = 15 * 60 * 1000;

export async function scanDeadlineReminders(pool: Pool, asOf = new Date()) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const heartbeat = await tx.query(
      `INSERT INTO heartbeat(service,last_seen_at) VALUES($1,$2)
       ON CONFLICT(service) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at
       WHERE heartbeat.last_seen_at<=EXCLUDED.last_seen_at RETURNING service`,
      [service, asOf],
    );
    if (!heartbeat.rowCount) {
      await tx.query('COMMIT');
      return 0;
    }
    const rows = await tx.query<{ changed: number }>(
      `WITH calendar AS (
         SELECT t.*,g.owner_user_id AS recipient_id,
           t.due_on - ($1::timestamptz AT TIME ZONE t.jurisdiction_tz)::date AS remaining_days
         FROM timer t JOIN goal g ON g.id=t.goal_id AND g.project_id=t.project_id
         JOIN app_user u ON u.id=g.owner_user_id AND u.status='active'
         WHERE t.state='active' AND g.status='active' AND t.due_at<=$1::timestamptz+interval '92 days'
       ), stages AS (
         SELECT calendar.*, CASE
           WHEN remaining_days<0 THEN 'OVERDUE'
           WHEN profile='certificate' AND remaining_days=0 THEN 'D-0'
           WHEN profile='certificate' AND remaining_days<=30 THEN 'D-30'
           WHEN profile='certificate' AND remaining_days<=60 THEN 'D-60'
           WHEN profile='certificate' AND remaining_days<=90 THEN 'D-90'
           WHEN profile='milestone' AND remaining_days<=1 THEN 'D-1'
           WHEN profile='milestone' AND remaining_days<=7 THEN 'D-7'
         END AS stage FROM calendar
       ), marked AS (
         SELECT s.*, existing.id AS pending_id, (existing.notice->>'remainingDays')::int AS prior_days,
           NOT EXISTS (
             SELECT 1 FROM notification n WHERE n.timer_id=s.id AND n.recipient_id=s.recipient_id
               AND (n.notice->>'dueAt')::timestamptz=s.due_at AND n.notice->>'profile'=s.profile
               AND n.notice->>'jurisdictionTz'=s.jurisdiction_tz AND n.notice->>'stage'=s.stage
               AND n.status IN ('pending','acknowledged')
           ) AS emit
         FROM stages s LEFT JOIN notification existing ON existing.timer_id=s.id
            AND existing.recipient_id=s.recipient_id AND existing.status='pending'
            AND (existing.notice->>'dueAt')::timestamptz=s.due_at AND existing.notice->>'profile'=s.profile
            AND existing.notice->>'jurisdictionTz'=s.jurisdiction_tz AND existing.notice->>'stage'=s.stage
         WHERE s.stage IS NOT NULL
       ), due AS (
         SELECT s.* FROM marked s JOIN timer live ON live.id=s.id
         JOIN goal g ON g.id=s.goal_id AND g.owner_user_id=s.recipient_id AND g.status='active'
         WHERE live.version=s.version AND live.state='active' AND (
           s.emit OR (s.pending_id IS NOT NULL AND s.prior_days<>s.remaining_days)
         ) ORDER BY s.due_at,s.id LIMIT 200 FOR UPDATE OF live SKIP LOCKED FOR SHARE OF g SKIP LOCKED
       ), stages_saved AS (
         UPDATE timer t SET last_stage=d.stage FROM due d WHERE t.id=d.id AND t.last_stage IS DISTINCT FROM d.stage
       ), refreshed AS (
         UPDATE notification n SET notice=jsonb_set(n.notice,'{remainingDays}',to_jsonb(d.remaining_days)),updated_at=$1
         FROM due d WHERE NOT d.emit AND n.id=d.pending_id AND n.status='pending'
         RETURNING n.id
       ), delivered AS (
         INSERT INTO notification(timer_id,recipient_id,notice,created_at,updated_at)
         SELECT id,recipient_id,jsonb_build_object('title',title,'stage',stage,'dueDate',due_on::text,
           'dueAt',due_at,'beijingTime',to_char(due_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS'),
           'remainingDays',remaining_days,'profile',profile,'jurisdictionTz',jurisdiction_tz),$1,$1
         FROM due WHERE emit
         ON CONFLICT (timer_id,recipient_id) WHERE status='pending'
         DO UPDATE SET notice=EXCLUDED.notice,updated_at=EXCLUDED.updated_at RETURNING id
       ) SELECT ((SELECT count(*) FROM refreshed)+(SELECT count(*) FROM delivered))::int AS changed`,
      [asOf],
    );
    await tx.query('COMMIT');
    return rows.rows[0]?.changed ?? 0;
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    tx.release();
  }
}

export async function readDeadlineScanHeartbeat(pool: Pick<Pool, 'query'>, asOf = new Date()) {
  const result = await pool.query<{ last_seen_at: Date }>(
    'SELECT last_seen_at FROM heartbeat WHERE service=$1',
    [service],
  );
  const lastSeen = result.rows[0]?.last_seen_at;
  return {
    lastSeenAt: lastSeen?.toISOString() ?? null,
    stale: !lastSeen || asOf.getTime() - lastSeen.getTime() >= staleAfterMs,
  };
}
