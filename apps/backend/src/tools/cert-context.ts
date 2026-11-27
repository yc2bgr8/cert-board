import { z } from 'zod';
import { goalStatusSchema, projectStatusSchema, type DataLevel } from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import type { ToolDefinition, ToolExecutionContext } from './registry.js';

const pageSize = 20;
const cursor = z.uuid().optional();
const selection = z
  .strictObject({
    scope: z.enum(['current', 'owned']).default('current'),
    projectCursor: cursor,
    goalCursor: cursor,
  })
  .refine(
    ({ scope, projectCursor, goalCursor }) => scope === 'owned' || (!projectCursor && !goalCursor),
    {
      message: '项目和目标的续读位置只用于本人负责的范围。',
    },
  );
const projectSummary = z.strictObject({
  id: z.uuid(),
  code: z.string().max(32),
  name: z.string().max(255),
  status: projectStatusSchema,
});
const goalSummary = z.strictObject({
  id: z.uuid(),
  projectId: z.uuid(),
  title: z.string().max(255),
  status: goalStatusSchema,
});
const resultSchema = z.strictObject({
  user: z.strictObject({
    id: z.uuid(),
    displayName: z.string().max(120),
    isManagement: z.boolean(),
  }),
  project: projectSummary.extend({
    ownerUserId: z.uuid(),
    market: z.enum(['US', 'CA', 'US_CA']),
    pathway: z.string().max(120),
    targetAt: z.iso.datetime().nullable(),
    jurisdictionTz: z.string().max(80),
    modelId: z.uuid().nullable(),
  }),
  goal: goalSummary
    .extend({
      ownerUserId: z.uuid(),
      dueAt: z.iso.datetime().nullable(),
      directionVersion: z.number().int().positive(),
      direction: z.string().max(1200).nullable(),
      directionTruncated: z.boolean(),
    })
    .nullable(),
  pending: z.strictObject({
    ownApprovals: z.number().int().nonnegative(),
    ownQuestions: z.number().int().nonnegative(),
    projectReviews: z.number().int().nonnegative(),
    projectProposals: z.number().int().nonnegative(),
  }),
  owned: z
    .strictObject({
      projects: projectSummary.array().max(pageSize),
      goals: goalSummary.array().max(pageSize),
      nextProjectCursor: z.uuid().nullable(),
      nextGoalCursor: z.uuid().nullable(),
    })
    .nullable(),
});
type ContextResult = z.infer<typeof resultSchema>;
type Owned = NonNullable<ContextResult['owned']>;
type Pending = ContextResult['pending'];

const stale = () =>
  new AppError(409, 'CERT_CONTEXT_CHANGED', '项目、目标或负责人已变更，请重新读取当前上下文。');
const iso = (value: Date | null) => value?.toISOString() ?? null;

async function ownedBy(
  ctx: ToolExecutionContext,
  filter: z.infer<typeof selection>,
): Promise<Owned> {
  const projects = (
    await ctx.tx.query<Owned['projects'][number]>(
      `SELECT id,code,name,status FROM cert_project
     WHERE owner_user_id=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3`,
      [ctx.actor.userId, filter.projectCursor ?? null, pageSize + 1],
    )
  ).rows;
  const goals = (
    await ctx.tx.query<Owned['goals'][number]>(
      `SELECT id,project_id AS "projectId",title,status FROM goal
     WHERE owner_user_id=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3`,
      [ctx.actor.userId, filter.goalCursor ?? null, pageSize + 1],
    )
  ).rows;
  return {
    projects: projects.slice(0, pageSize),
    goals: goals.slice(0, pageSize),
    nextProjectCursor: projects.length > pageSize ? projects[pageSize - 1]!.id : null,
    nextGoalCursor: goals.length > pageSize ? goals[pageSize - 1]!.id : null,
  };
}

async function levelOf(ctx: ToolExecutionContext, result: ContextResult): Promise<DataLevel> {
  if (
    result.project.id !== ctx.projectId ||
    (result.goal?.id ?? null) !== ctx.goalId ||
    result.user.id !== ctx.actor.userId
  )
    throw stale();
  const owned = result.owned;
  if (owned?.projects.length) {
    const { rowCount } = await ctx.tx.query(
      'SELECT id FROM cert_project WHERE owner_user_id=$1 AND id=ANY($2::uuid[]) FOR SHARE',
      [ctx.actor.userId, owned.projects.map(({ id }) => id)],
    );
    if (rowCount !== owned.projects.length) throw stale();
  }
  if (owned?.goals.length) {
    const { rows } = await ctx.tx.query<{ id: string; project_id: string }>(
      'SELECT id,project_id FROM goal WHERE owner_user_id=$1 AND id=ANY($2::uuid[]) FOR SHARE',
      [ctx.actor.userId, owned.goals.map(({ id }) => id)],
    );
    const current = new Map(rows.map(({ id, project_id }) => [id, project_id]));
    if (owned.goals.some(({ id, projectId }) => current.get(id) !== projectId)) throw stale();
  }
  const ids = [
    ...new Set([
      result.project.id,
      ...(owned?.projects.map(({ id }) => id) ?? []),
      ...(owned?.goals.map(({ projectId }) => projectId) ?? []),
    ]),
  ];
  // 按全部实际返回的归属项目复核密级，包括回放旧调用时已升密的项目。
  const {
    rows: [guard],
  } = await ctx.tx.query<{ confidential: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM workspace WHERE project_id=ANY($1::uuid[]) AND data_level='confidential')
          OR EXISTS(SELECT 1 FROM document_version v JOIN document d ON d.id=v.document_id
            WHERE d.project_id=ANY($1::uuid[]) AND v.data_level='confidential')
          OR EXISTS(SELECT 1 FROM review_card WHERE project_id=ANY($1::uuid[]) AND data_level='confidential')
          OR EXISTS(SELECT 1 FROM tool_approval WHERE project_id=ANY($1::uuid[]) AND data_level='confidential')
          OR EXISTS(SELECT 1 FROM proposal WHERE project_id=ANY($1::uuid[]) AND data_level='confidential')
          AS confidential`,
    [ids],
  );
  return guard?.confidential ? 'confidential' : ctx.maxDataLevel;
}

export function certContextTool(): ToolDefinition {
  return {
    metadata: {
      name: 'cert_context',
      version: 'builtin-cert-context-v1',
      publication: 'published',
      effect: 'read',
      modes: ['read_only', 'ask', 'full'],
      approvalInAsk: false,
      outputDataLevel: 'dynamic',
      authorizationAction: 'project.read',
      description: {
        purpose: '读取当前用户、管理权限、当前项目和目标，以及待处理事项数量。',
        whenToUse: '开始立项规划或路径研判前，核对当前项目、目标、方向和法域。',
        avoid:
          '不替代原文取证或正式判断。找原文用 doc_search 和 doc_read；计算倒排用 work_schedule_calculate。',
        parameters:
          '省略 scope 时只读当前范围。scope=owned 时附上本人负责的项目及目标，每类最多 20 条；续读时传对应的 projectCursor 或 goalCursor。',
        example: { scope: 'current' },
      },
    },
    inputSchema: selection,
    outputSchema: resultSchema,
    async execute(ctx, input) {
      if (!ctx.projectId)
        throw new AppError(
          403,
          'CERT_CONTEXT_PROJECT_REQUIRED',
          '请先从项目打开本次对话，再读取项目上下文。',
        );
      const filter = selection.parse(input);
      const {
        rows: [user],
      } = await ctx.tx.query(
        `SELECT id,display_name AS "displayName",is_management AS "isManagement"
         FROM app_user WHERE id=$1 AND status='active'`,
        [ctx.actor.userId],
      );
      const {
        rows: [project],
      } = await ctx.tx.query<
        Omit<ContextResult['project'], 'targetAt'> & { targetAt: Date | null }
      >(
        `SELECT id,code,name,status,owner_user_id AS "ownerUserId",market,pathway,
                target_at AS "targetAt",jurisdiction_tz AS "jurisdictionTz",model_id AS "modelId"
         FROM cert_project WHERE id=$1`,
        [ctx.projectId],
      );
      if (!project || !user) throw stale();
      const goal = ctx.goalId
        ? (
            await ctx.tx.query<
              Omit<NonNullable<ContextResult['goal']>, 'dueAt'> & { dueAt: Date | null }
            >(
              `SELECT g.id,g.project_id AS "projectId",g.title,g.status,g.owner_user_id AS "ownerUserId",
                g.due_at AS "dueAt",g.direction_version AS "directionVersion",
                left(d.note,1200) AS direction, COALESCE(length(d.note)>1200,false) AS "directionTruncated"
         FROM goal g LEFT JOIN goal_direction d ON d.goal_id=g.id AND d.version=g.direction_version
         WHERE g.id=$1 AND g.project_id=$2`,
              [ctx.goalId, ctx.projectId],
            )
          ).rows[0]
        : undefined;
      if (ctx.goalId && !goal) throw stale();
      const {
        rows: [pending],
      } = await ctx.tx.query<Pending>(
        `SELECT
          (SELECT count(*)::int FROM tool_approval a JOIN run r ON r.id=a.run_id
           JOIN conversation c ON c.id=a.conversation_id
           WHERE a.user_id=$1 AND a.project_id=$2 AND ($3::uuid IS NULL OR a.goal_id=$3)
           AND a.status='pending' AND c.status='active' AND r.status IN ('running','waiting')) AS "ownApprovals",
          (SELECT count(*)::int FROM tool_invocation i JOIN run r ON r.id=i.run_id
           JOIN conversation c ON c.id=r.conversation_id
           WHERE r.user_id=$1 AND r.project_id=$2 AND ($3::uuid IS NULL OR r.goal_id=$3)
           AND r.status='waiting' AND c.status='active' AND c.current_run_id=r.id AND i.tool_name='ask_user'
           AND i.status='completed' AND NOT EXISTS(SELECT 1 FROM conversation_answer a WHERE a.question_invocation_id=i.id)) AS "ownQuestions",
          (SELECT count(*)::int FROM review_card WHERE project_id=$2 AND ($3::uuid IS NULL OR goal_id=$3)
           AND status='pending') AS "projectReviews",
          (SELECT count(*)::int FROM proposal WHERE project_id=$2 AND ($3::uuid IS NULL OR goal_id=$3)
           AND status='proposed') AS "projectProposals"`,
        [ctx.actor.userId, ctx.projectId, ctx.goalId],
      );
      const data = resultSchema.parse({
        user,
        project: { ...project, targetAt: iso(project.targetAt) },
        goal: goal ? { ...goal, dueAt: iso(goal.dueAt) } : null,
        pending,
        owned: filter.scope === 'owned' ? await ownedBy(ctx, filter) : null,
      });
      return { data, dataLevel: ctx.maxDataLevel };
    },
    async refreshDataLevel(ctx, cached) {
      return levelOf(ctx, resultSchema.parse(cached));
    },
  };
}
