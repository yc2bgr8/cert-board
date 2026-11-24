import type { Pool, PoolClient } from 'pg';
import {
  dailyDigestContentSchema,
  dailyDigestLimit,
  dailyDigestResponseSchema,
  type DailyDigestContent,
} from '@cert-board/shared';
import { readMemberNotificationsForUser } from '../conversations/read.js';

export const dailyDigestHour = 17;
export const dailyDigestTimezone = 'Asia/Shanghai';
type DigestWindow = {
  date: string;
  start: Date;
  eligible: boolean;
};

function noticeKey(item: DailyDigestContent['pending'][number]) {
  return `${item.kind}:${item.id}`;
}
export function latestDigestNotices(items: DailyDigestContent['pending']) {
  const latest = new Map<string, DailyDigestContent['pending'][number]>();
  for (const item of items) {
    const key = noticeKey(item);
    const prior = latest.get(key);
    if (
      !prior ||
      item.createdAt > prior.createdAt ||
      (item.createdAt === prior.createdAt && item.id > prior.id)
    )
      latest.set(key, item);
  }
  return [...latest.values()].sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
  );
}

async function digestWindow(database: Pool, now: Date) {
  const {
    rows: [window],
  } = await database.query<DigestWindow>(
    `WITH clock AS (SELECT timezone($2::text,$1::timestamptz) AS local,
        make_time($3::int,0,0) AS send_time)
      SELECT local::date::text AS date,
        (local::date::timestamp AT TIME ZONE $2) AS start,
        extract(isodow FROM local) BETWEEN 1 AND 5 AND local::time>=send_time AS eligible
      FROM clock`,
    [now, dailyDigestTimezone, dailyDigestHour],
  );
  return window!;
}

const resourceFields = `g.id,g.title,g.project_id AS "projectId",
  (SELECT c.id FROM conversation c WHERE c.goal_id=g.id AND c.user_id=g.owner_user_id
    ORDER BY c.updated_at DESC,c.id DESC LIMIT 1) AS "conversationId"`;
async function digestForUser(
  tx: PoolClient,
  userId: string,
  window: DigestWindow,
  observedAt: Date,
) {
  const args = [userId, window.start, observedAt, dailyDigestLimit + 1];
  const completed = (
    await tx.query(
      `SELECT ${resourceFields} FROM goal g WHERE g.owner_user_id=$1 AND g.status='completed'
     AND g.updated_at >= $2 AND g.updated_at <= $3 ORDER BY g.updated_at DESC,g.id DESC LIMIT $4`,
      args,
    )
  ).rows;
  const tomorrow = (
    await tx.query(
      `SELECT t.id,t.title,t.project_id AS "projectId",t.conversation_id AS "conversationId",
       t.due_on::text AS "dueOn",t.jurisdiction_tz AS "jurisdictionTz"
       FROM timer t JOIN goal g ON g.id=t.goal_id
       WHERE g.owner_user_id=$1 AND g.status NOT IN ('completed','cancelled')
         AND t.state='active' AND t.due_on=(($2::timestamptz AT TIME ZONE t.jurisdiction_tz)::date+1)
         AND t.created_at<=$2
       ORDER BY t.due_at,t.id LIMIT $3`,
      [userId, observedAt, dailyDigestLimit + 1],
    )
  ).rows;
  const localTestMessages = (
    await tx.query(
      `SELECT m.id,'本地测试消息回执' AS title,m.project_id AS "projectId",
       m.conversation_id AS "conversationId"
       FROM internal_outbound_message m WHERE m.user_id=$1 AND m.status='done'
         AND m.channel='local_test' AND m.processed_at >= $2 AND m.processed_at <= $3
       ORDER BY m.processed_at DESC,m.id DESC LIMIT $4`,
      args,
    )
  ).rows;
  const snapshot = await readMemberNotificationsForUser(tx, userId, { observedAt });
  const pending = latestDigestNotices(snapshot.items);
  const groups = [completed, pending, tomorrow, localTestMessages];
  if (groups.every((group) => group.length === 0)) return null;
  return dailyDigestContentSchema.parse({
    completed: completed.slice(0, dailyDigestLimit),
    pending: pending.slice(0, dailyDigestLimit),
    tomorrow: tomorrow.slice(0, dailyDigestLimit),
    localTestMessages: localTestMessages.slice(0, dailyDigestLimit),
    truncated: snapshot.truncated || groups.some((group) => group.length > dailyDigestLimit),
  });
}

export async function buildDailyDigests(pool: Pool, now = new Date()) {
  const window = await digestWindow(pool, now);
  if (!window.eligible) return 0;
  const { rows: users } = await pool.query<{ id: string }>(
    `SELECT u.id FROM app_user u WHERE u.status='active'
      AND NOT EXISTS (SELECT 1 FROM daily_digest d WHERE d.user_id=u.id AND d.business_date=$1)
      ORDER BY u.id`,
    [window.date],
  );
  let created = 0;
  for (const { id } of users) {
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      const active = await tx.query(
        "SELECT 1 FROM app_user WHERE id=$1 AND status='active' FOR SHARE",
        [id],
      );
      if (active.rowCount) {
        const summary = await digestForUser(tx, id, window, now);
        if (summary) {
          const saved = await tx.query(
            `INSERT INTO daily_digest(user_id,business_date,content,generated_at)
              VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(user_id,business_date) DO NOTHING`,
            [id, window.date, JSON.stringify(summary), now],
          );
          created += saved.rowCount ?? 0;
        }
      }
      await tx.query('COMMIT');
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      tx.release();
    }
  }
  return created;
}

export async function readDailyDigest(tx: PoolClient, userId: string) {
  const {
    rows: [row],
  } = await tx.query<{ date: string; generated_at: Date; content: unknown }>(
    `SELECT business_date::text AS date,generated_at,content FROM daily_digest
      WHERE user_id=$1 ORDER BY business_date DESC LIMIT 1`,
    [userId],
  );
  if (!row) return dailyDigestResponseSchema.parse({ digest: null });
  const content = dailyDigestContentSchema.parse(row.content);
  const keys = new Set(content.pending.map(noticeKey));
  const current = await readMemberNotificationsForUser(tx, userId, {
    ids: content.pending.map((item) => item.id),
  });
  return dailyDigestResponseSchema.parse({
    digest: {
      ...content,
      date: row.date,
      generatedAt: row.generated_at.toISOString(),
      pending: latestDigestNotices(current.items).filter((item) => keys.has(noticeKey(item))),
    },
  });
}
