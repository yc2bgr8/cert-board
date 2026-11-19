import {
  reminderInputSchema,
  reminderResultSchema,
  reminderUndoSchema,
  type ToolApprovalPreview,
  type UndoCapture,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import type { ToolExecutionContext, ToolUndoRecord } from '../tools/registry.js';
import { calculateDeadline } from './calendar.js';

type TimerRow = {
  id: string;
  goal_id: string;
  owner_id: string;
  conversation_id: string;
  title: string;
  profile: string;
  calculation: unknown;
  due_date: string;
  due_at: Date;
  state: string;
  last_stage: string | null;
  version: number;
};
const unavailable = () =>
  new AppError(409, 'REMINDER_GOAL_UNAVAILABLE', '请在仍有效的项目目标中配置站内提醒。');
const conflict = () =>
  new AppError(409, 'REMINDER_CHANGED', '提醒已有更新，请先读取当前状态再试。');

async function scope(ctx: ToolExecutionContext) {
  if (!ctx.projectId || !ctx.goalId || ctx.goalStatus !== 'active') throw unavailable();
  const { rows } = await ctx.tx.query<{ id: string; owner_user_id: string; version: number }>(
    `SELECT g.id,g.owner_user_id,g.version FROM goal g
     JOIN app_user u ON u.id=g.owner_user_id AND u.status='active'
     WHERE g.id=$1 AND g.project_id=$2 AND g.status='active' FOR SHARE OF g,u`,
    [ctx.goalId, ctx.projectId],
  );
  if (!rows[0]) throw unavailable();
  return rows[0];
}

async function previous(ctx: ToolExecutionContext) {
  const result = await ctx.tx.query<TimerRow>(
    `SELECT t.*,t.due_on::text AS due_date,g.owner_user_id AS owner_id FROM timer t
     JOIN goal g ON g.id=t.goal_id AND g.project_id=t.project_id
     WHERE t.id=$1 AND t.goal_id=$1 AND t.project_id=$2`,
    [ctx.goalId, ctx.projectId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return reminderUndoSchema.shape.previous.parse({
    conversationId: row.conversation_id,
    lastStage: row.last_stage,
    state: row.state,
    plan: {
      id: row.id,
      goalId: row.goal_id,
      ownerId: row.owner_id,
      title: row.title,
      profile: row.profile,
      calculation: row.calculation,
      dueDate: row.due_date,
      dueAt: row.due_at.toISOString(),
      version: row.version,
    },
  });
}

export async function captureReminder(ctx: ToolExecutionContext) {
  const goal = await scope(ctx);
  const current = await previous(ctx);
  return {
    targetType: 'deadline_timer',
    targetId: goal.id,
    beforeState: { previous: current },
    beforeVersion: current?.plan.version ?? null,
  };
}

export async function reminderVersion(ctx: ToolExecutionContext, targetId: string) {
  if (targetId !== ctx.goalId) throw unavailable();
  return (await previous(ctx))?.plan.version ?? null;
}

async function calculateForReminder(ctx: ToolExecutionContext, input: unknown) {
  const deadline = calculateDeadline(input);
  const supported = await ctx.tx.query('SELECT 1 FROM pg_timezone_names WHERE name=$1', [
    deadline.calculation.jurisdictionTz,
  ]);
  if (!supported.rowCount)
    throw new AppError(
      400,
      'REMINDER_TIMEZONE_UNAVAILABLE',
      '数据库暂不支持该法域时区，请核对配置。',
    );
  return deadline;
}

export async function previewReminder(
  ctx: ToolExecutionContext,
  input: unknown,
): Promise<ToolApprovalPreview> {
  const goal = await scope(ctx);
  const saved = await previous(ctx);
  const { title, profile, calculation } = reminderInputSchema.parse(input);
  const deadline = await calculateForReminder(ctx, calculation);
  return {
    summary: '设置当前目标的站内期限提醒',
    changes: [
      {
        recordType: 'deadline_timer',
        recordId: goal.id,
        field: 'deadline',
        before: saved?.plan ?? null,
        after: {
          title,
          profile,
          dueAt: deadline.dueAt,
          calculation: deadline.calculation,
          ownerId: goal.owner_user_id,
        },
      },
    ],
    targetVersions: [
      { targetType: 'goal', targetId: goal.id, version: String(goal.version) },
      {
        targetType: 'deadline_timer',
        targetId: goal.id,
        version: saved ? String(saved.plan.version) : null,
      },
    ],
    dataLevel: ctx.maxDataLevel,
  };
}

async function syncPending(ctx: ToolExecutionContext, id: string, title?: string) {
  if (title === undefined) {
    await ctx.tx.query(
      "UPDATE notification SET status='cancelled',updated_at=clock_timestamp() WHERE timer_id=$1 AND status='pending'",
      [id],
    );
  } else {
    await ctx.tx.query(
      "UPDATE notification SET notice=jsonb_set(notice,'{title}',to_jsonb($2::text)),updated_at=clock_timestamp() WHERE timer_id=$1 AND status='pending' AND notice->>'title'<>$2",
      [id, title],
    );
  }
}

export async function setReminder(ctx: ToolExecutionContext, input: unknown, before?: UndoCapture) {
  const goal = await scope(ctx);
  if (before?.targetId !== goal.id || before.targetType !== 'deadline_timer') throw unavailable();
  const { previous: saved } = reminderUndoSchema.parse(before.beforeState);
  const { title, profile, calculation } = reminderInputSchema.parse(input);
  const deadline = await calculateForReminder(ctx, calculation);
  const keep =
    saved?.state === 'active' &&
    saved.plan.profile === profile &&
    saved.plan.dueAt === deadline.dueAt &&
    saved.plan.calculation.jurisdictionTz === deadline.calculation.jurisdictionTz;
  const { rows } = await ctx.tx.query<{ version: number }>(
    `INSERT INTO timer(id,goal_id,project_id,conversation_id,title,profile,calculation,due_on,due_at,jurisdiction_tz,last_stage)
     VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT(id) DO UPDATE SET conversation_id=EXCLUDED.conversation_id,title=EXCLUDED.title,
       profile=EXCLUDED.profile,calculation=EXCLUDED.calculation,due_on=EXCLUDED.due_on,due_at=EXCLUDED.due_at,
       jurisdiction_tz=EXCLUDED.jurisdiction_tz,last_stage=EXCLUDED.last_stage,state='active',
       version=timer.version+1,updated_at=clock_timestamp()
     WHERE timer.project_id=$2 AND timer.goal_id=$1 AND timer.version=$11 RETURNING version`,
    [
      goal.id,
      ctx.projectId,
      ctx.conversationId,
      title,
      profile,
      JSON.stringify(deadline.calculation),
      deadline.dueDate,
      deadline.dueAt,
      deadline.calculation.jurisdictionTz,
      keep ? saved.lastStage : null,
      saved?.plan.version ?? null,
    ],
  );
  const version = rows[0]?.version;
  if (!version) throw conflict();
  await syncPending(ctx, goal.id, keep ? title : undefined);
  return {
    afterVersion: version,
    dataLevel: ctx.maxDataLevel,
    data: reminderResultSchema.parse({
      id: goal.id,
      goalId: goal.id,
      ownerId: goal.owner_user_id,
      title,
      profile,
      calculation: deadline.calculation,
      dueDate: deadline.dueDate,
      dueAt: deadline.dueAt,
      version,
    }),
  };
}

export async function undoReminder(ctx: ToolExecutionContext, record: ToolUndoRecord) {
  const goal = await scope(ctx);
  if (record.targetId !== goal.id || record.targetType !== 'deadline_timer') throw unavailable();
  const { previous: saved } = reminderUndoSchema.parse(record.beforeState);
  const current = await previous(ctx);
  const keep =
    saved?.state === 'active' &&
    current?.state === 'active' &&
    saved.plan.profile === current.plan.profile &&
    saved.plan.dueAt === current.plan.dueAt &&
    saved.plan.calculation.jurisdictionTz === current.plan.calculation.jurisdictionTz;
  const result = saved
    ? await ctx.tx.query<{ version: number }>(
        `UPDATE timer SET title=$4,profile=$5,calculation=$6,due_on=$7,due_at=$8,jurisdiction_tz=$9,
       state=$10,conversation_id=$11,last_stage=$12,version=version+1,updated_at=clock_timestamp()
       WHERE id=$1 AND project_id=$2 AND version=$3 RETURNING version`,
        [
          goal.id,
          ctx.projectId,
          record.afterVersion,
          saved.plan.title,
          saved.plan.profile,
          JSON.stringify(saved.plan.calculation),
          saved.plan.dueDate,
          saved.plan.dueAt,
          saved.plan.calculation.jurisdictionTz,
          saved.state,
          saved.conversationId,
          keep ? current.lastStage : saved.lastStage,
        ],
      )
    : await ctx.tx.query<{ version: number }>(
        `UPDATE timer SET state='cancelled',last_stage=NULL,version=version+1,updated_at=clock_timestamp()
       WHERE id=$1 AND project_id=$2 AND version=$3 RETURNING version`,
        [goal.id, ctx.projectId, record.afterVersion],
      );
  const version = result.rows[0]?.version;
  if (!version) throw conflict();
  await syncPending(ctx, goal.id, keep ? saved.plan.title : undefined);
  return { afterVersion: version };
}
