import type { Pool } from 'pg';

export async function preserveLegacyNoticeScope(db: Pick<Pool, 'query'>, timerId?: string) {
  await db.query(
    `UPDATE notification n
     SET notice=n.notice||jsonb_build_object(
       'profile',COALESCE(n.notice->>'profile',t.profile),
       'jurisdictionTz',COALESCE(n.notice->>'jurisdictionTz',t.jurisdiction_tz))
     FROM timer t WHERE n.timer_id=t.id AND ($1::uuid IS NULL OR t.id=$1)
       AND (n.notice->>'dueAt')::timestamptz=t.due_at
       AND (n.notice->>'profile' IS NULL OR n.notice->>'jurisdictionTz' IS NULL)`,
    [timerId ?? null],
  );
}
