import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  m02ScheduleViewSchema,
  type BrowserIdentity,
  type M02ScheduleInput,
  type RulePackSeed,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { appendConversationMessageTx } from '../conversations/storage.js';
import { latestRulePack } from '../knowledge/rule-packs.js';

const packCode = 'us_fda_m02';
const civilDate = z.iso.date();
const missing = () =>
  new AppError(404, 'M02_GOAL_UNAVAILABLE', '请打开自己负责的美国维护目标，再设置 M02 定时核查。');
type ScheduleRow = { enabled: boolean; enabled_by: string; version: number; updated_at: Date };

export async function getM02Schedule(
  db: Pick<Pool, 'query'>,
  actor: BrowserIdentity,
  goalId: string,
) {
  const {
    rows: [row],
  } = await db.query<{ enabled: boolean; version: number; updated_at: Date | null }>(
    `SELECT COALESCE(s.enabled AND s.enabled_by=g.owner_user_id,false) AS enabled,
        COALESCE(s.version,0) AS version,s.updated_at
      FROM goal g JOIN cert_project p ON p.id=g.project_id LEFT JOIN m02_schedule s ON s.goal_id=g.id
      WHERE g.id=$1 AND g.owner_user_id=$2 AND p.project_type='maintenance' AND p.market='US'`,
    [goalId, actor.userId],
  );
  if (!row) throw missing();
  return m02ScheduleViewSchema.parse({
    enabled: row.enabled,
    version: row.version,
    updatedAt: row.updated_at?.toISOString() ?? null,
  });
}

export async function setM02Schedule(
  db: PoolClient,
  actor: BrowserIdentity,
  goalId: string,
  input: M02ScheduleInput,
) {
  if (actor.kind !== 'browser') throw missing();
  const {
    rows: [goal],
  } = await db.query<{ status: string; project_open: boolean; workspace_ready: boolean }>(
    `SELECT g.status,p.status NOT IN ('closed','cancelled') AS project_open,
       EXISTS(SELECT 1 FROM workspace w WHERE w.project_id=p.id AND w.current_version_id IS NOT NULL) AS workspace_ready
       FROM goal g JOIN cert_project p ON p.id=g.project_id
       WHERE g.id=$1 AND g.owner_user_id=$2 AND p.project_type='maintenance' AND p.market='US' FOR UPDATE OF g`,
    [goalId, actor.userId],
  );
  if (!goal) throw missing();
  if (input.enabled && (goal.status !== 'active' || !goal.project_open || !goal.workspace_ready))
    throw new AppError(409, 'M02_GOAL_INACTIVE', '请先恢复维护目标和项目，并为项目准备工作区。');
  const {
    rows: [before],
  } = await db.query<ScheduleRow>('SELECT * FROM m02_schedule WHERE goal_id=$1', [goalId]);
  if ((before?.version ?? 0) !== input.expectedVersion)
    throw new AppError(409, 'M02_SCHEDULE_CHANGED', '定时设置已变化，请刷新后重试。');
  if (before && before.enabled === input.enabled && before.enabled_by === actor.userId)
    return m02ScheduleViewSchema.parse({
      enabled: before.enabled,
      version: before.version,
      updatedAt: before.updated_at.toISOString(),
    });
  const {
    rows: [saved],
  } = await db.query<ScheduleRow>(
    `INSERT INTO m02_schedule(goal_id,enabled,enabled_by) VALUES($1,$2,$3)
       ON CONFLICT(goal_id) DO UPDATE SET enabled=EXCLUDED.enabled,enabled_by=EXCLUDED.enabled_by,
         updated_at=clock_timestamp(),version=m02_schedule.version+1 RETURNING *`,
    [goalId, input.enabled, actor.userId],
  );
  await db.query(
    `INSERT INTO audit_log(actor_user_id,actor_kind,action,target_type,target_id)
       VALUES($1,'browser',$2,'goal',$3)`,
    [actor.userId, input.enabled ? 'm02.schedule_enabled' : 'm02.schedule_disabled', goalId],
  );
  return m02ScheduleViewSchema.parse({
    enabled: saved!.enabled,
    version: saved!.version,
    updatedAt: saved!.updated_at.toISOString(),
  });
}

export function m02Periods(today: string, seed: RulePackSeed) {
  const year = today.slice(0, 4);
  const record = seed.rules.find(({ id }) => id === 'annual_registration_window');
  const starts = civilDate.safeParse(`${year}-${record?.parameters?.window_start ?? ''}`);
  const ends = civilDate.safeParse(`${year}-${record?.parameters?.window_end ?? ''}`);
  let annual: string | null = null;
  if (starts.success && ends.success && starts.data <= ends.data) {
    const preparation = new Date(`${starts.data}T00:00:00Z`);
    preparation.setUTCDate(preparation.getUTCDate() - 1);
    if (today >= preparation.toISOString().slice(0, 10) && today <= ends.data) annual = year;
  }
  return { month: today.slice(0, 7), annual };
}

async function enqueueM02(
  pool: Pool,
  goalId: string,
  pack: NonNullable<Awaited<ReturnType<typeof latestRulePack>>>,
  now: Date,
) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const {
      rows: [goal],
    } = await db.query<{
      project_id: string;
      owner_user_id: string;
      direction_version: number;
      today: string;
      restricted: boolean;
    }>(
      `SELECT g.project_id,g.owner_user_id,g.direction_version,
         to_char(($2::timestamptz AT TIME ZONE p.jurisdiction_tz)::date,'YYYY-MM-DD') AS today,
         (w.data_level='confidential' OR EXISTS(SELECT 1 FROM document d JOIN document_version v ON v.document_id=d.id
           WHERE d.project_id=p.id AND v.data_level='confidential') OR EXISTS(SELECT 1 FROM fact f
           WHERE f.project_id=p.id AND f.data_level='confidential')) AS restricted
       FROM m02_schedule s JOIN goal g ON g.id=s.goal_id JOIN cert_project p ON p.id=g.project_id
       JOIN app_user u ON u.id=g.owner_user_id AND u.status='active'
       JOIN workspace w ON w.project_id=p.id AND w.current_version_id IS NOT NULL
       JOIN pg_timezone_names tz ON tz.name=p.jurisdiction_tz
       WHERE g.id=$1 AND s.enabled AND s.enabled_by=g.owner_user_id
         AND g.status='active' AND p.project_type='maintenance' AND p.market='US'
         AND p.status NOT IN ('closed','cancelled')
       FOR SHARE OF u FOR UPDATE OF g,s`,
      [goalId, now],
    );
    if (!goal) {
      await db.query('ROLLBACK');
      return false;
    }
    const periods = m02Periods(goal.today, pack.seed);
    const month = `m02:${goalId}:monthly:${periods.month}`;
    const annual = periods.annual ? `m02:${goalId}:annual:${periods.annual}` : null;
    const possible = annual ? [annual, month] : [month];
    const { rows: fired } = await db.query<{ source_key: string }>(
      `SELECT source_key FROM goal_event WHERE source='timer' AND source_key=ANY($1::text[])`,
      [possible],
    );
    const due = possible.filter((key) => !fired.some(({ source_key }) => source_key === key));
    if (
      !due.length ||
      (
        await db.query(
          `SELECT 1 FROM run WHERE goal_id=$1 AND status IN ('queued','running','waiting')
       UNION ALL SELECT 1 FROM goal_event WHERE goal_id=$1 AND state='queued' LIMIT 1`,
          [goalId],
        )
      ).rowCount
    ) {
      await db.query('ROLLBACK');
      return false;
    }
    const conversation = randomUUID();
    const run = randomUUID();
    const level = goal.restricted ? 'confidential' : 'internal';
    const title = annual && due.includes(annual) ? 'M02 年度注册窗口核查' : 'M02 月度公开资料核查';
    await db.query(
      `INSERT INTO conversation(id,project_id,user_id,goal_id,title,permission_mode,agent_code,max_data_level,current_run_id)
        VALUES($1,$2,$3,$4,$5,'full','maintenance',$6,NULL)`,
      [conversation, goal.project_id, goal.owner_user_id, goalId, title, level],
    );
    await db.query(
      `INSERT INTO run(id,conversation_id,user_id,project_id,goal_id,direction_version,trigger_type,status,max_data_level)
       VALUES($1,$2,$3,$4,$5,$6,'wakeup','queued',$7)`,
      [
        run,
        conversation,
        goal.owner_user_id,
        goal.project_id,
        goalId,
        goal.direction_version,
        level,
      ],
    );
    await db.query('UPDATE conversation SET current_run_id=$2 WHERE id=$1', [conversation, run]);
    await db.query('INSERT INTO run_rule_pack(run_id,pack_id,version_id) VALUES($1,$2,$3)', [
      run,
      pack.packId,
      pack.versionId,
    ]);
    const event = await db.query<{ id: string }>(
      `INSERT INTO goal_event(goal_id,source,source_key,state,wake_run_id)
       SELECT $1,'timer',key,'queued',$2 FROM unnest($3::text[]) AS pending(key) RETURNING id`,
      [goalId, run, due],
    );
    await appendConversationMessageTx(db, {
      runId: run,
      userId: goal.owner_user_id,
      requestKey: event.rows[0]!.id,
      message: {
        role: 'user',
        content: `系统定时唤醒：${title}。项目法域日期 ${goal.today}。请按 M02 核查并提出站内提醒与人工审核所需交付。`,
      },
    });
    await db.query(
      "INSERT INTO audit_log(actor_kind,action,target_type,target_id) VALUES('system','m02.schedule_wakeup','run',$1)",
      [run],
    );
    await db.query('COMMIT');
    return true;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

export async function scanM02Schedules(pool: Pool, environment: string, now = new Date()) {
  const { rows } = await pool.query<{ goal_id: string }>(
    'SELECT goal_id FROM m02_schedule WHERE enabled ORDER BY goal_id',
  );
  if (!rows.length) return 0;
  const pack = await latestRulePack(pool, packCode, environment);
  if (!pack) return 0;
  let dispatched = 0;
  for (const { goal_id } of rows) if (await enqueueM02(pool, goal_id, pack, now)) dispatched++;
  return dispatched;
}
