import type { Pool } from 'pg';

export async function preserveLegacyNoticeScope(db: Pick<Pool, 'query'>, timerId?: string) {
  await db.query(
    `UPDATE notification n
     SET notice=jsonb_build_object('profile',t.profile,'jurisdictionTz',t.jurisdiction_tz)||n.notice
     FROM timer t WHERE n.timer_id=t.id AND ($1::uuid IS NULL OR t.id=$1)
       AND (n.notice->>'dueAt')::timestamptz=t.due_at
       AND (NOT (n.notice ? 'profile') OR NOT (n.notice ? 'jurisdictionTz'))`,
    [timerId ?? null],
  );
}
