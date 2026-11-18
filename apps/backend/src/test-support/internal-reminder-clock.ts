import type { Pool } from 'pg';

export const reminderFriday = '2026-11-20T15:59:59Z';
export const reminderSaturday = '2026-11-20T16:00:00Z';
export const reminderSunday = '2026-11-21T16:00:00Z';
export const reminderMonday = '2026-11-22T16:00:00Z';

export async function setTestReminderClock(pool: Pool, instant = reminderFriday) {
  if (process.env.NODE_ENV !== 'test' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(instant)) {
    throw new Error('提醒时钟夹具只允许在测试库使用标准 UTC 时间');
  }
  const database = await pool.query<{ name: string }>('SELECT current_database() AS name');
  if (!/^cert_[a-f0-9]{24}_test$/.test(database.rows[0]!.name)) {
    throw new Error('提醒时钟夹具只允许在临时测试库使用');
  }
  await pool.query(`CREATE OR REPLACE FUNCTION public.internal_reminder_now() RETURNS timestamptz
    LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$ SELECT '${instant}'::timestamptz $$`);
}
