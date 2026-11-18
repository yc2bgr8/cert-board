import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z, type ZodType } from 'zod';
import {
  agentIdentitySchema,
  toolCallContextSchema,
  toolCatalogContextSchema,
  toolMetadataSchema,
  toolExecutionResultSchema,
  toolStoredPayloadSchema,
  toolVersionTokenSchema,
  undoCaptureSchema,
  documentDataLevelSchema,
  type AgentIdentity,
  type ToolCallContext,
  type ToolMetadata,
  type UndoCapture,
  type DataLevel,
  type Role,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { authorize } from '../auth/authorization.js';
import { decideTool, toolDescription } from './policy.js';

type VersionInput = string | number;
type GoalStatus =
  | 'active'
  | 'waiting_materials'
  | 'waiting_external'
  | 'waiting_decision'
  | 'pending_review'
  | 'human_controlled'
  | 'paused'
  | 'completed'
  | 'cancelled';
export interface ToolExecutionContext {
  readonly tx: PoolClient;
  readonly actor: AgentIdentity;
  readonly runId: string;
  readonly callId: string;
  readonly conversationId: string;
  readonly projectId: string | null;
  readonly goalId: string | null;
  readonly mode: 'read_only' | 'execute';
  readonly goalStatus: GoalStatus | null;
  readonly directionVersion: number;
  readonly maxDataLevel: DataLevel;
}
export interface ToolHandlerResult<Output = unknown> {
  data: Output;
  dataLevel: DataLevel;
  afterVersion?: VersionInput;
}
export interface ToolUndoRecord extends UndoCapture {
  id: string;
  invocationId: string;
  runId: string;
  conversationId: string;
  userId: string;
  toolName: string;
  toolVersion: string;
  afterVersion: string;
}
export interface ToolUndoSpec<Input = unknown> {
  beforeSchema: ZodType;
  capture(
    ctx: ToolExecutionContext,
    input: Input,
  ): Promise<
    UndoCapture | (Omit<UndoCapture, 'beforeVersion'> & { beforeVersion: VersionInput | null })
  >;
  currentVersion(
    ctx: ToolExecutionContext,
    record: UndoCapture | ToolUndoRecord,
  ): Promise<VersionInput | null>;
  apply(ctx: ToolExecutionContext, record: ToolUndoRecord): Promise<{ afterVersion: VersionInput }>;
}
export interface ToolDefinition<Input = unknown, Output = unknown> {
  metadata: ToolMetadata;
  inputSchema: ZodType<Input>;
  outputSchema: ZodType<Output>;
  execute?(
    ctx: ToolExecutionContext,
    input: Input,
    before?: UndoCapture,
  ): Promise<ToolHandlerResult<Output>>;
  propose?(ctx: ToolExecutionContext, input: Input): Promise<ToolHandlerResult<Output>>;
  refreshDataLevel?(ctx: ToolExecutionContext, cachedData: Output): Promise<DataLevel>;
  undo?: ToolUndoSpec<Input>;
}
export type ToolResultEnvelope = {
  invocationId: string;
  data: unknown;
  dataLevel: DataLevel;
  undoId: string | null;
  replayed: boolean;
  status: 'completed' | 'pending_proposal';
};
type StoredPayload = ReturnType<typeof toolStoredPayloadSchema.parse>;
type LoadedContext = ToolExecutionContext & { projectOwnerId: string | null };
type RunRow = {
  id: string;
  conversation_id: string;
  user_id: string;
  project_id: string | null;
  goal_id: string | null;
  direction_version: number;
  status: string;
  max_data_level: DataLevel;
};
type InvocationRow = {
  id: string;
  tool_name: string;
  tool_version: string;
  arguments_hash: string;
  operation: string;
  status: string;
  data_level: DataLevel;
};
type UndoRow = {
  id: string;
  invocation_id: string;
  run_id: string;
  conversation_id: string;
  user_id: string;
  tool_name: string;
  tool_version: string;
  target_type: string;
  target_id: string;
  before_state: unknown;
  before_version: string | null;
  after_version: string | null;
  status: string;
  undone_version: string | null;
};
class ToolBoundaryError extends AppError {}
const fail = (status: number, code: string, message: string) =>
  new ToolBoundaryError(status, code, message);
const levels: DataLevel[] = ['public', 'internal', 'confidential'];
const highest = (...values: DataLevel[]) =>
  values.reduce<DataLevel>(
    (level, value) => (levels.indexOf(value) > levels.indexOf(level) ? value : level),
    'internal',
  );
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function availableUndo(definition: ToolDefinition) {
  const undo = definition.undo;
  return Boolean(
    undo?.beforeSchema?.safeParse &&
    typeof undo.capture === 'function' &&
    typeof undo.currentVersion === 'function' &&
    typeof undo.apply === 'function',
  );
}
function versionToken(value: unknown): string | null {
  if (value === null) return null;
  const parsed = toolVersionTokenSchema.safeParse(value);
  if (!parsed.success)
    throw fail(
      500,
      'TOOL_VERSION_INVALID',
      '工具未提供有效业务版本，已停止写入；请维护人员检查工具契约。',
    );
  return parsed.data;
}
const safeReviewHints = new Map<string, string>([
  [
    'REVIEW_READ_REQUIRED',
    '每条完整引文都须有本对话成功的doc_read回执。请重新读取对应资料版本和页码，确保一段结果完整包含引文，再提交审核。',
  ],
  [
    'REVIEW_EVIDENCE_INSUFFICIENT',
    '至少需要两条不同的完整资料引文；重复引用或仅改变空白不增加证据数。请补充doc_read取得的依据后重试。',
  ],
  [
    'REVIEW_CHECK_FAILED',
    '关键检查未通过，尚未建立审核卡。请先用check_run查看问题，修正引用、来源或结构后再提交。',
  ],
  [
    'REVIEW_SKILL_UNAVAILABLE',
    '技能编号或版本不在当前已登记版本中。请先读取当前技能，不要猜测版本后重试。',
  ],
  [
    'REVIEW_INPUT_INVALID',
    '结构化交付格式不正确。请按工具说明补齐字段，并用check_run检查后再提交。',
  ],
  ['REVIEW_DIFF_LIMIT', '改动文件超过当前审核上限，请缩小交付范围后重新保存和提交。'],
  ['REVIEW_FILE_LIMIT', '工作区文件数量超过当前审核上限，请缩小交付范围后重试。'],
]);

async function callback<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ToolBoundaryError) throw error;
    if (error instanceof AppError && error.statusCode === 409)
      throw fail(
        409,
        'TOOL_TARGET_CONFLICT',
        '目标或工作副本已经变化，请重新读取当前版本与差异，完成确认后再重试。',
      );
    if (error instanceof AppError && [403, 404].includes(error.statusCode))
      throw fail(
        error.statusCode,
        'TOOL_TARGET_UNAVAILABLE',
        '当前身份或目标状态已不允许此操作，请刷新项目、资料和工具目录后重试。',
      );
    if (error instanceof AppError && [400, 413, 415, 422].includes(error.statusCode))
      throw fail(
        error.statusCode,
        'TOOL_DATA_REJECTED',
        safeReviewHints.get(error.code) ??
          '输入或业务检查未通过，请核对参数、分页位置或资料解析状态后重试。',
      );
    throw fail(
      500,
      'TOOL_EXECUTION_FAILED',
      '工具执行失败，本次业务写入已撤销。请检查输入或联系维护人员，不要猜测操作结果。',
    );
  }
}

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition>();
  private readonly production: boolean;
  constructor(
    private readonly pool: Pool,
    definitions: readonly ToolDefinition[],
    options: { environment?: 'development' | 'test' | 'production' } = {},
  ) {
    this.production =
      (options.environment ?? process.env.NODE_ENV ?? 'production') === 'production';
    for (const definition of definitions) {
      const parsed = toolMetadataSchema.safeParse(definition.metadata);
      if (
        !parsed.success ||
        !definition.inputSchema?.safeParse ||
        !definition.outputSchema?.safeParse
      )
        throw fail(
          500,
          'TOOL_REGISTRATION_INVALID',
          '工具登记缺少动作级别、版本或输入输出模式，请维护人员修正后再启动。',
        );
      const metadata = frozen(parsed.data);
      if (this.definitions.has(metadata.name))
        throw fail(
          500,
          'TOOL_DUPLICATE',
          '同名工具重复登记，已拒绝启动，请维护人员检查已发布目录。',
        );
      if (
        metadata.outputDataLevel === 'dynamic' &&
        typeof definition.refreshDataLevel !== 'function'
      )
        throw fail(
          500,
          'TOOL_LEVEL_RESOLVER_REQUIRED',
          '动态资料工具必须提供当前级别校验方法，不能仅依赖历史缓存。',
        );
      if (
        ['read', 'reversible_write'].includes(metadata.effect) &&
        typeof definition.execute !== 'function'
      )
        throw fail(500, 'TOOL_HANDLER_REQUIRED', '工具缺少已发布执行实现，请维护人员补全登记。');
      this.definitions.set(
        metadata.name,
        Object.freeze({
          ...definition,
          metadata,
          ...(definition.undo ? { undo: Object.freeze({ ...definition.undo }) } : {}),
        }),
      );
    }
  }

  private async context(tx: PoolClient, reference: ToolCallContext): Promise<LoadedContext> {
    const located = await tx.query<RunRow>(
      'SELECT id,conversation_id,user_id,project_id,goal_id,direction_version,status,max_data_level FROM run WHERE id=$1 AND user_id=$2',
      [reference.runId, reference.userId],
    );
    const initial = located.rows[0];
    if (!initial)
      throw fail(403, 'TOOL_RUN_FORBIDDEN', '运行不存在或不属于当前用户，已拒绝工具调用。');
    const users = await tx.query<{
      id: string;
      username: string;
      display_name: string;
      is_development: boolean;
    }>(
      "SELECT id,username,display_name,is_development FROM app_user WHERE id=$1 AND status='active' FOR SHARE",
      [reference.userId],
    );
    const user = users.rows[0];
    if (!user || (this.production && user.is_development))
      throw fail(403, 'TOOL_USER_INACTIVE', '用户已停用或不能在当前环境执行，请联系负责人。');
    let workspaceLevel: DataLevel = 'internal';
    if (initial.project_id) {
      const workspaces = await tx.query<{ data_level: DataLevel }>(
        'SELECT id,data_level FROM workspace WHERE project_id=$1 FOR UPDATE',
        [initial.project_id],
      );
      workspaceLevel = workspaces.rows[0]?.data_level ?? 'internal';
    }
    let goalStatus: GoalStatus | null = null;
    let goalDirection: number | null = null;
    if (initial.goal_id) {
      const goals = await tx.query<{
        status: GoalStatus;
        direction_version: number;
        project_id: string;
      }>('SELECT status,direction_version,project_id FROM goal WHERE id=$1 FOR UPDATE', [
        initial.goal_id,
      ]);
      const goal = goals.rows[0];
      if (!goal || goal.project_id !== initial.project_id)
        throw fail(403, 'TOOL_GOAL_MISMATCH', '运行与目标项目不一致，请重新建立运行。');
      goalStatus = goal.status;
      goalDirection = goal.direction_version;
    }
    const conversations = await tx.query<{
      id: string;
      user_id: string;
      project_id: string | null;
      goal_id: string | null;
      mode: 'read_only' | 'execute';
      status: string;
      max_data_level: DataLevel;
    }>(
      'SELECT id,user_id,project_id,goal_id,mode,status,max_data_level FROM conversation WHERE id=$1 FOR UPDATE',
      [initial.conversation_id],
    );
    const conversation = conversations.rows[0];
    const runs = await tx.query<RunRow>(
      'SELECT id,conversation_id,user_id,project_id,goal_id,direction_version,status,max_data_level FROM run WHERE id=$1 FOR UPDATE',
      [initial.id],
    );
    const run = runs.rows[0];
    if (
      !run ||
      !conversation ||
      run.user_id !== reference.userId ||
      conversation.user_id !== reference.userId ||
      run.conversation_id !== conversation.id ||
      run.project_id !== conversation.project_id ||
      run.goal_id !== conversation.goal_id
    )
      throw fail(
        403,
        'TOOL_CONTEXT_MISMATCH',
        '运行与对话归属不一致，已拒绝执行，请重新打开项目对话。',
      );
    if (run.status !== 'running' || conversation.status !== 'active')
      throw fail(409, 'TOOL_RUN_INACTIVE', '运行或对话已停止、完成或归档，不能继续调用工具。');
    if (goalDirection !== null && run.direction_version !== goalDirection)
      throw fail(
        409,
        'TOOL_DIRECTION_STALE',
        '目标方向已经更新，请停止旧运行并按最新方向重新开始。',
      );
    const roles = await tx.query(
      'SELECT role,scope_type AS "scopeType",scope_id AS "scopeId" FROM role_binding WHERE user_id=$1 FOR SHARE',
      [user.id],
    );
    const actor = frozen(
      agentIdentitySchema.parse({
        kind: 'agent',
        runId: run.id,
        userId: user.id,
        username: user.username,
        displayName: user.display_name,
        isDevelopment: user.is_development,
        roles: roles.rows,
      }),
    );
    let projectOwnerId: string | null = null;
    if (run.project_id) {
      const projects = await tx.query<{ owner_user_id: string }>(
        'SELECT owner_user_id FROM cert_project WHERE id=$1 FOR SHARE',
        [run.project_id],
      );
      projectOwnerId = projects.rows[0]?.owner_user_id ?? null;
      if (!projectOwnerId)
        throw fail(403, 'TOOL_PROJECT_UNAVAILABLE', '运行所属项目不存在，不能执行工具。');
    }
    return Object.freeze({
      tx,
      actor,
      runId: run.id,
      callId: reference.callId,
      conversationId: conversation.id,
      projectId: run.project_id,
      goalId: run.goal_id,
      mode: conversation.mode,
      goalStatus,
      directionVersion: run.direction_version,
      maxDataLevel: highest(run.max_data_level, conversation.max_data_level, workspaceLevel),
      projectOwnerId,
    });
  }

  private async transaction<T>(
    reference: ToolCallContext,
    operation: (ctx: LoadedContext) => Promise<T>,
  ): Promise<T> {
    const tx = await this.pool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `tool-call:${reference.runId}:${reference.callId}`,
      ]);
      const context = await this.context(tx, reference);
      const result = await operation(context);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => undefined);
      if (error instanceof ToolBoundaryError) throw error;
      throw fail(
        500,
        'TOOL_TRANSACTION_FAILED',
        '工具事务未完成，本次业务写入已撤销，请检查服务状态后重试。',
      );
    } finally {
      tx.release();
    }
  }
  private scopedContext(definition: ToolDefinition, ctx: LoadedContext): LoadedContext {
    const actor = frozen({
      ...ctx.actor,
      roles: ctx.actor.roles.filter((binding) => definition.metadata.roles.includes(binding.role)),
    });
    return Object.freeze({ ...ctx, actor });
  }
  private decision(definition: ToolDefinition, context: LoadedContext) {
    const ctx = this.scopedContext(definition, context);
    const roles = [...new Set(ctx.actor.roles.map((binding) => binding.role))] as Role[];
    const action = definition.metadata.authorizationAction;
    const personal = action.startsWith('conversation.') || action.startsWith('sales.request.');
    return decideTool(definition.metadata, {
      roles,
      mode: ctx.mode,
      goalStatus: ctx.goalStatus,
      hasUndo: availableUndo(definition),
      resourceAllowed: authorize(ctx.actor, definition.metadata.authorizationAction, {
        projectId: ctx.projectId,
        ownerUserId: personal ? ctx.actor.userId : (ctx.projectOwnerId ?? ctx.actor.userId),
      }),
    });
  }
  private allowed(definition: ToolDefinition, ctx: LoadedContext) {
    const decision = this.decision(definition, ctx);
    if (decision.decision === 'deny') throw fail(403, decision.code, decision.message);
    return decision;
  }
  async catalog(reference: unknown) {
    const parsed = toolCatalogContextSchema.safeParse(reference);
    if (!parsed.success) throw fail(400, 'TOOL_CONTEXT_INVALID', '运行身份无效，请重新打开对话。');
    return this.transaction({ ...parsed.data, callId: 'catalog' }, async (ctx) =>
      [...this.definitions.values()]
        .filter((definition) => this.decision(definition, ctx).decision !== 'deny')
        .map((definition) => ({
          name: definition.metadata.name,
          version: definition.metadata.version,
          effect: definition.metadata.effect,
          description: toolDescription(definition.metadata),
          parameters: z.toJSONSchema(definition.inputSchema, {
            io: 'input',
            unrepresentable: 'any',
          }),
        })),
    );
  }

  private async propagate(ctx: LoadedContext, level: DataLevel, invocationId?: string) {
    await ctx.tx.query(
      'UPDATE conversation SET max_data_level=GREATEST(max_data_level,$1::document_data_level),version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$2 AND max_data_level<$1::document_data_level',
      [level, ctx.conversationId],
    );
    await ctx.tx.query(
      'UPDATE run SET max_data_level=GREATEST(max_data_level,$1::document_data_level),version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$2 AND max_data_level<$1::document_data_level',
      [level, ctx.runId],
    );
    if (invocationId)
      await ctx.tx.query(
        'UPDATE tool_invocation SET data_level=GREATEST(data_level,$1::document_data_level),updated_at=CURRENT_TIMESTAMP WHERE id=$2 AND data_level<$1::document_data_level',
        [level, invocationId],
      );
  }
  private async replay(
    ctx: LoadedContext,
    definition: ToolDefinition,
    invocation: InvocationRow,
    argumentsHash: string,
    operation: 'execute' | 'undo',
    sourceData?: unknown,
  ): Promise<ToolResultEnvelope> {
    if (
      invocation.tool_name !== definition.metadata.name ||
      invocation.tool_version !== definition.metadata.version ||
      invocation.arguments_hash !== argumentsHash ||
      invocation.operation !== operation
    )
      throw fail(
        409,
        'TOOL_IDEMPOTENCY_CONFLICT',
        '同一调用编号对应的工具版本或参数发生变化，请为新的调用使用新的编号。',
      );
    if (invocation.status !== 'completed')
      throw fail(
        409,
        'TOOL_CALL_INCOMPLETE',
        '先前调用未形成完整回执，请联系维护人员核对，不要猜测业务结果。',
      );
    const stored = await ctx.tx.query<{ content_json: unknown }>(
      'SELECT content_json FROM conversation_tool_result WHERE invocation_id=$1 AND conversation_id=$2 AND user_id=$3',
      [invocation.id, ctx.conversationId, ctx.actor.userId],
    );
    const parsed = toolStoredPayloadSchema.safeParse(stored.rows[0]?.content_json);
    if (!parsed.success)
      throw fail(
        409,
        'TOOL_RESULT_EXPIRED',
        '原调用回执已清理或无法读取，请核对目标现状后发起新调用，不能直接重做旧编号。',
      );
    const payload = parsed.data;
    let currentLevel: DataLevel =
      definition.metadata.outputDataLevel === 'dynamic'
        ? 'internal'
        : definition.metadata.outputDataLevel;
    if (
      definition.metadata.outputDataLevel === 'dynamic' &&
      payload.status !== 'pending_proposal'
    ) {
      if (!definition.refreshDataLevel)
        throw fail(
          500,
          'TOOL_LEVEL_RESOLVER_REQUIRED',
          '动态资料工具缺少级别刷新方法，已拒绝历史结果重放。',
        );
      const refreshed = await callback(() =>
        definition.refreshDataLevel!(
          ctx,
          sourceData === undefined ? payload.result.data : sourceData,
        ),
      );
      const validated = documentDataLevelSchema.safeParse(refreshed);
      if (!validated.success)
        throw fail(500, 'TOOL_DATA_LEVEL_UNKNOWN', '无法确定资料当前级别，已拒绝返回历史内容。');
      currentLevel = validated.data;
    }
    const level = highest(
      ctx.maxDataLevel,
      invocation.data_level,
      payload.result.dataLevel,
      currentLevel,
    );
    await this.propagate(ctx, level, invocation.id);
    const undo = await ctx.tx.query<{ id: string }>(
      'SELECT id FROM undo_record WHERE invocation_id=$1',
      [invocation.id],
    );
    return {
      invocationId: invocation.id,
      data: payload.result.data,
      dataLevel: level,
      undoId: undo.rows[0]?.id ?? null,
      replayed: true,
      status: payload.status,
    };
  }
  private async startInvocation(
    ctx: LoadedContext,
    definition: ToolDefinition,
    argumentsHash: string,
    operation: 'execute' | 'undo',
  ) {
    const result = await ctx.tx.query<{ id: string }>(
      `INSERT INTO tool_invocation(run_id,conversation_id,user_id,call_id,tool_name,tool_version,arguments_hash,effect,operation)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        ctx.runId,
        ctx.conversationId,
        ctx.actor.userId,
        ctx.callId,
        definition.metadata.name,
        definition.metadata.version,
        argumentsHash,
        definition.metadata.effect,
        operation,
      ],
    );
    return result.rows[0]!.id;
  }
  private async complete(
    ctx: LoadedContext,
    invocationId: string,
    definition: ToolDefinition,
    payload: StoredPayload,
    undoId: string | null,
    auditAction: string,
    sourceData?: unknown,
  ): Promise<ToolResultEnvelope> {
    let refreshed: DataLevel = 'internal';
    if (
      definition.metadata.outputDataLevel === 'dynamic' &&
      payload.status !== 'pending_proposal'
    ) {
      const level = await callback(() =>
        definition.refreshDataLevel!(
          ctx,
          sourceData === undefined ? payload.result.data : sourceData,
        ),
      );
      const parsedLevel = documentDataLevelSchema.safeParse(level);
      if (!parsedLevel.success)
        throw fail(500, 'TOOL_DATA_LEVEL_UNKNOWN', '无法确定资料当前级别，已拒绝返回工具内容。');
      refreshed = parsedLevel.data;
    }
    const level = highest(
      ctx.maxDataLevel,
      payload.result.dataLevel,
      refreshed,
      definition.metadata.outputDataLevel === 'dynamic'
        ? 'internal'
        : definition.metadata.outputDataLevel,
    );
    const content = toolStoredPayloadSchema.parse({
      ...payload,
      result: { ...payload.result, dataLevel: level },
    });
    await this.propagate(ctx, level);
    await ctx.tx.query(
      'INSERT INTO conversation_tool_result(invocation_id,conversation_id,user_id,content_json,data_level) VALUES($1,$2,$3,$4,$5)',
      [invocationId, ctx.conversationId, ctx.actor.userId, content, level],
    );
    await ctx.tx.query(
      "UPDATE tool_invocation SET status='completed',data_level=$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2",
      [level, invocationId],
    );
    await ctx.tx.query(
      "INSERT INTO audit_log(actor_user_id,actor_kind,action,target_type,target_id) VALUES($1,'agent',$2,'tool_invocation',$3)",
      [ctx.actor.userId, auditAction, invocationId],
    );
    return {
      invocationId,
      data: content.result.data,
      dataLevel: level,
      undoId,
      replayed: false,
      status: content.status,
    };
  }

  async execute(reference: unknown, name: string, args: unknown): Promise<ToolResultEnvelope> {
    const parsed = toolCallContextSchema.safeParse(reference);
    if (!parsed.success)
      throw fail(
        400,
        'TOOL_CONTEXT_INVALID',
        '运行身份或调用编号无效，请使用当前运行分配的调用编号。',
      );
    const definition = this.definitions.get(name);
    if (!definition)
      throw fail(403, 'TOOL_UNREGISTERED', '工具未登记，请从当前目录选择，不要猜测接口。');
    const input = definition.inputSchema.safeParse(args);
    const json = z.json().safeParse(args);
    if (!input.success || !json.success)
      throw fail(
        400,
        'TOOL_INPUT_INVALID',
        '工具参数不符合已发布契约，请按工具说明修正必需字段、范围和格式。',
      );
    const argumentsHash = hash(
      JSON.stringify(
        canonical({
          operation: 'execute',
          name,
          version: definition.metadata.version,
          args: json.data,
        }),
      ),
    );
    return this.transaction(parsed.data, async (context) => {
      const ctx = this.scopedContext(definition, context);
      const decision = this.allowed(definition, ctx);
      const found = await ctx.tx.query<InvocationRow>(
        'SELECT id,tool_name,tool_version,arguments_hash,operation,status,data_level FROM tool_invocation WHERE run_id=$1 AND call_id=$2',
        [ctx.runId, ctx.callId],
      );
      if (found.rows[0])
        return this.replay(ctx, definition, found.rows[0], argumentsHash, 'execute');
      const invocationId = await this.startInvocation(ctx, definition, argumentsHash, 'execute');
      let undoId: string | null = null,
        before: UndoCapture | undefined;
      if (definition.metadata.effect === 'reversible_write') {
        const spec = definition.undo;
        if (!spec) throw fail(403, 'TOOL_UNDO_REQUIRED', '写入工具缺少撤销方式，已拒绝执行。');
        const rawCapture = await callback(() => spec.capture(ctx, input.data));
        const normalizedState = spec.beforeSchema.safeParse(rawCapture?.beforeState);
        if (!normalizedState.success)
          throw fail(
            500,
            'TOOL_UNDO_CAPTURE_INVALID',
            '工具无法提供受控的业务原值，本次写入未执行。',
          );
        const captured = undoCaptureSchema.safeParse({
          ...rawCapture,
          beforeState: normalizedState.data,
        });
        if (!captured.success)
          throw fail(
            500,
            'TOOL_UNDO_CAPTURE_INVALID',
            '工具无法提供受控的业务原值和版本，本次写入未执行。',
          );
        before = frozen(captured.data);
        const actual = versionToken(await callback(() => spec.currentVersion(ctx, before!)));
        if (actual !== before.beforeVersion)
          throw fail(409, 'TOOL_TARGET_CONFLICT', '目标版本已变化，请重新读取业务记录后重试。');
        const undo = await ctx.tx.query<{ id: string }>(
          `INSERT INTO undo_record(invocation_id,run_id,conversation_id,user_id,tool_name,tool_version,target_type,target_id,before_state,before_version,status)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending') RETURNING id`,
          [
            invocationId,
            ctx.runId,
            ctx.conversationId,
            ctx.actor.userId,
            definition.metadata.name,
            definition.metadata.version,
            before.targetType,
            before.targetId,
            before.beforeState,
            before.beforeVersion,
          ],
        );
        undoId = undo.rows[0]!.id;
      }
      let result: ReturnType<typeof toolExecutionResultSchema.parse>;
      let status: 'completed' | 'pending_proposal' = 'completed';
      if (decision.decision === 'propose' && !definition.propose) {
        status = 'pending_proposal';
        result = {
          data: {
            proposed: false,
            pending: true,
            message:
              '此动作只能生成提案；提案服务尚未接入，未建立真实提案，也未对外发送。请交负责人处理。',
          },
          dataLevel: ctx.maxDataLevel,
        };
      } else {
        const returned = await callback(() =>
          decision.decision === 'propose'
            ? definition.propose!(ctx, input.data)
            : definition.execute!(ctx, input.data, before),
        );
        const resultParsed = toolExecutionResultSchema.safeParse(returned);
        if (!resultParsed.success)
          throw fail(
            500,
            'TOOL_OUTPUT_INVALID',
            '工具结果不符合结构或长度上限，本次业务写入已撤销；请使用有界输出和分页。',
          );
        const output = definition.outputSchema.safeParse(resultParsed.data.data);
        if (!output.success)
          throw fail(
            500,
            'TOOL_OUTPUT_INVALID',
            '工具输出不符合已发布模式，本次业务写入已撤销，请维护人员检查实现。',
          );
        const normalized = toolExecutionResultSchema.safeParse({
          ...resultParsed.data,
          data: output.data,
        });
        if (!normalized.success)
          throw fail(500, 'TOOL_OUTPUT_INVALID', '工具输出转换后无效，本次业务写入已撤销。');
        result = normalized.data;
      }
      if (undoId && before && definition.undo) {
        const actual = versionToken(
          await callback(() => definition.undo!.currentVersion(ctx, before!)),
        );
        if (
          !result.afterVersion ||
          actual !== result.afterVersion ||
          result.afterVersion === before.beforeVersion
        )
          throw fail(
            500,
            'TOOL_WRITE_VERSION_INVALID',
            '写入后版本未推进或与实际业务版本不一致，本次业务写入已撤销。',
          );
        await ctx.tx.query(
          "UPDATE undo_record SET after_version=$1,status='available',updated_at=CURRENT_TIMESTAMP WHERE id=$2",
          [result.afterVersion, undoId],
        );
      }
      return this.complete(
        ctx,
        invocationId,
        definition,
        toolStoredPayloadSchema.parse({ status, result }),
        undoId,
        'tool.executed',
      );
    });
  }

  async undo(reference: unknown, undoId: string): Promise<ToolResultEnvelope> {
    const parsed = toolCallContextSchema.safeParse(reference);
    if (!parsed.success || !z.uuid().safeParse(undoId).success)
      throw fail(400, 'TOOL_CONTEXT_INVALID', '撤销编号或运行身份无效，请使用当前对话的撤销凭据。');
    return this.transaction(parsed.data, async (context) => {
      const original = await context.tx.query<
        UndoRow & { project_id: string | null; goal_id: string | null }
      >(
        `SELECT u.*,r.project_id,r.goal_id FROM undo_record u JOIN run r ON r.id=u.run_id WHERE u.id=$1 AND u.conversation_id=$2 AND u.user_id=$3 FOR UPDATE OF u`,
        [undoId, context.conversationId, context.actor.userId],
      );
      const row = original.rows[0];
      if (!row || row.project_id !== context.projectId || row.goal_id !== context.goalId)
        throw fail(403, 'TOOL_UNDO_FORBIDDEN', '撤销凭据不属于当前对话、用户或目标，已拒绝。');
      const definition = this.definitions.get(row.tool_name);
      if (!definition || definition.metadata.version !== row.tool_version || !definition.undo)
        throw fail(
          409,
          'TOOL_UNDO_VERSION_UNAVAILABLE',
          '原工具的已发布撤销版本不可用，请联系维护人员核对，不能使用新版本猜测恢复。',
        );
      const ctx = this.scopedContext(definition, context);
      this.allowed(definition, ctx);
      if (definition.metadata.effect !== 'reversible_write')
        throw fail(403, 'TOOL_UNDO_FORBIDDEN', '此工具不属于可撤销写入，不能执行补偿。');
      const argumentsHash = hash(JSON.stringify({ operation: 'undo', undoId }));
      let sourceData: unknown;
      if (definition.metadata.outputDataLevel === 'dynamic') {
        const source = await ctx.tx.query<{ content_json: unknown }>(
          'SELECT content_json FROM conversation_tool_result WHERE invocation_id=$1 AND conversation_id=$2 AND user_id=$3',
          [row.invocation_id, ctx.conversationId, ctx.actor.userId],
        );
        const parsedSource = toolStoredPayloadSchema.safeParse(source.rows[0]?.content_json);
        if (!parsedSource.success)
          throw fail(
            409,
            'TOOL_UNDO_SOURCE_UNAVAILABLE',
            '原工具资料定位回执已不可用，无法校验当前级别，请联系负责人处理。',
          );
        sourceData = parsedSource.data.result.data;
      }
      const existing = await ctx.tx.query<InvocationRow>(
        'SELECT id,tool_name,tool_version,arguments_hash,operation,status,data_level FROM tool_invocation WHERE run_id=$1 AND call_id=$2',
        [ctx.runId, ctx.callId],
      );
      if (existing.rows[0])
        return this.replay(ctx, definition, existing.rows[0], argumentsHash, 'undo', sourceData);
      const invocationId = await this.startInvocation(ctx, definition, argumentsHash, 'undo');
      if (row.status === 'undone')
        return this.complete(
          ctx,
          invocationId,
          definition,
          {
            status: 'completed',
            result: {
              data: {
                undoId,
                status: 'undone',
                alreadyUndone: true,
                afterVersion: row.undone_version,
              },
              dataLevel: ctx.maxDataLevel,
            },
          },
          null,
          'tool.undo_replayed',
          sourceData,
        );
      if (row.status !== 'available' || !row.after_version)
        throw fail(409, 'TOOL_UNDO_UNAVAILABLE', '原操作尚无完整撤销凭据，请核对原调用结果。');
      const captured = undoCaptureSchema.safeParse({
        targetType: row.target_type,
        targetId: row.target_id,
        beforeState: row.before_state,
        beforeVersion: row.before_version,
      });
      // 存储的原值已在capture阶段规范化且不可变，不能再次执行可能非幂等的输入transform。
      if (!captured.success)
        throw fail(500, 'TOOL_UNDO_SNAPSHOT_INVALID', '撤销快照不符合原工具契约，已拒绝恢复。');
      const record: ToolUndoRecord = frozen({
        ...captured.data,
        id: row.id,
        invocationId: row.invocation_id,
        runId: row.run_id,
        conversationId: row.conversation_id,
        userId: row.user_id,
        toolName: row.tool_name,
        toolVersion: row.tool_version,
        afterVersion: row.after_version,
      });
      const actual = versionToken(
        await callback(() => definition.undo!.currentVersion(ctx, record)),
      );
      if (actual !== record.afterVersion)
        throw fail(
          409,
          'TOOL_UNDO_CONFLICT',
          '记录在原操作之后已被修改，不能覆盖后续更改；请重新读取并由负责人决定。',
        );
      const applied = await callback(() => definition.undo!.apply(ctx, record));
      const afterVersion = versionToken(applied.afterVersion);
      const storedVersion = versionToken(
        await callback(() => definition.undo!.currentVersion(ctx, record)),
      );
      if (
        afterVersion === null ||
        afterVersion !== storedVersion ||
        afterVersion === record.afterVersion
      )
        throw fail(
          500,
          'TOOL_UNDO_VERSION_INVALID',
          '撤销后版本未正确推进，本次补偿已撤销，请维护人员检查工具。',
        );
      await ctx.tx.query(
        "UPDATE undo_record SET status='undone',undone_version=$1,undone_at=CURRENT_TIMESTAMP,undone_by=$2,updated_at=CURRENT_TIMESTAMP WHERE id=$3",
        [afterVersion, ctx.actor.userId, undoId],
      );
      return this.complete(
        ctx,
        invocationId,
        definition,
        {
          status: 'completed',
          result: {
            data: { undoId, status: 'undone', alreadyUndone: false, afterVersion },
            dataLevel: ctx.maxDataLevel,
          },
        },
        null,
        'tool.undone',
        sourceData,
      );
    });
  }
}
