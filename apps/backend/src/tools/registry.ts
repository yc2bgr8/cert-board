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
  toolApprovalPreviewSchema,
  approvalResolutionSchema,
  conversationEventSchema,
  type AgentIdentity,
  type ToolCallContext,
  type ToolMetadata,
  type UndoCapture,
  type DataLevel,
  type PermissionMode,
  type ToolApprovalPreview,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { authorize } from '../auth/authorization.js';
import { decideTool, toolDescription } from './policy.js';
import {
  createToolApproval,
  hasConversationToolGrant,
  replayToolApproval,
  approvalContentHash,
} from '../approvals/service.js';

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
  readonly permissionMode: PermissionMode;
  readonly goalStatus: GoalStatus | null;
  readonly directionVersion: number;
  readonly maxDataLevel: DataLevel;
  readonly signal?: AbortSignal;
}
export type ToolRuntimeGuard = (context: ToolExecutionContext) => Promise<void>;
export interface ToolHandlerResult<Output = unknown> {
  data: Output;
  dataLevel: DataLevel;
  afterVersion?: VersionInput;
  noChange?: true;
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
  allowNoChange?: true;
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
  // 由已登记工具生成可信预览，只读实际目标，不执行业务动作或写撤销记录。
  prepareApproval?(ctx: ToolExecutionContext, input: Input): Promise<ToolApprovalPreview>;
  refreshDataLevel?(ctx: ToolExecutionContext, cachedData: Output): Promise<DataLevel>;
  undo?: ToolUndoSpec<Input>;
}
export type ToolResultEnvelope = {
  invocationId: string;
  data: unknown;
  dataLevel: DataLevel;
  undoId: string | null;
  replayed: boolean;
  status:
    'completed' | 'pending_proposal' | 'pending_approval' | 'approval_rejected' | 'approval_stale';
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
type ApprovedCall = {
  id: string;
  invocation_id: string;
  run_id: string;
  conversation_id: string;
  user_id: string;
  project_id: string;
  goal_id: string;
  tool_name: string;
  tool_version: string;
  arguments_hash: string;
  content_hash: string;
  direction_version: number;
  data_level: DataLevel;
  arguments_json: unknown;
  preview_json: unknown;
  target_versions_json: unknown;
  status: string;
  version: number;
  decision_id: string;
  decision_action: 'allow_once' | 'allow_conversation' | 'reject';
  decision_hash: string;
  source_version: number;
  rejection_reason: string | null;
  ticket_state: string;
  claimed_generation: string | null;
  invocation_status: string;
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
  ['SANDBOX_DUPLICATE_INPUT', '输入别名重复，请为每个文件使用不同名称。'],
  ['SANDBOX_INPUT_LIMIT', '输入合计超过 12 MiB，请减少文件后重试。'],
  ['SANDBOX_OUTPUT_LIMIT', '产出超过文件数或总大小上限，请拆分处理后重试。'],
  ['SANDBOX_OUTPUT_TYPE_REJECTED', '产出目录只接受普通文件，请删除链接及特殊文件后重试。'],
  [
    'REVIEW_READ_REQUIRED',
    '每条完整引文都须有本对话成功的doc_read回执。请重新读取对应资料版本和页码，确保一段结果完整包含引文，再提交审核。',
  ],
  [
    'REVIEW_EVIDENCE_INSUFFICIENT',
    '依据数量低于当前技能的要求。请用 skill_load 核对要求，并用 doc_read 补充不同的完整引文。',
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
    if (error instanceof AppError && error.code === 'INTERNAL_REMINDER_WEEKEND')
      throw fail(422, 'TOOL_DATA_REJECTED', '周六、周日不催办，请在北京时间下一个工作日重新提出。');
    if (error instanceof AppError && error.code === 'SANDBOX_BUSY' && error.statusCode === 429)
      throw fail(
        429,
        'TOOL_DATA_REJECTED',
        '已有程序正在沙箱运行，请在本轮执行其他事项，稍后再试。',
      );
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
  private readonly runtimeGuard: ToolRuntimeGuard | undefined;
  private readonly runtimeSignal: AbortSignal | undefined;
  constructor(
    private readonly pool: Pool,
    definitions: readonly ToolDefinition[],
    options: {
      environment?: 'development' | 'test' | 'production';
      runtimeGuard?: ToolRuntimeGuard;
      signal?: AbortSignal;
    } = {},
  ) {
    this.runtimeGuard = options.runtimeGuard;
    this.runtimeSignal = options.signal;
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
      if (
        metadata.effect === 'reversible_write' &&
        metadata.approvalInAsk &&
        typeof definition.prepareApproval !== 'function'
      )
        throw fail(
          500,
          'TOOL_APPROVAL_PREVIEW_REQUIRED',
          '需要批准的工具必须提供可信操作预览，请维护人员补全登记。',
        );
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
      is_management: boolean;
    }>(
      "SELECT id,username,display_name,is_development,is_management FROM app_user WHERE id=$1 AND status='active' FOR SHARE",
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
      permission_mode: PermissionMode;
      status: string;
      max_data_level: DataLevel;
    }>(
      'SELECT id,user_id,project_id,goal_id,permission_mode,status,max_data_level FROM conversation WHERE id=$1 FOR UPDATE',
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
    const actor = frozen(
      agentIdentitySchema.parse({
        kind: 'agent',
        runId: run.id,
        userId: user.id,
        username: user.username,
        displayName: user.display_name,
        isDevelopment: user.is_development,
        isManagement: user.is_management,
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
      permissionMode: conversation.permission_mode,
      goalStatus,
      directionVersion: run.direction_version,
      maxDataLevel: highest(run.max_data_level, conversation.max_data_level, workspaceLevel),
      projectOwnerId,
      ...(this.runtimeSignal ? { signal: this.runtimeSignal } : {}),
    });
  }

  private async assertRuntime(context: LoadedContext) {
    if (!this.runtimeGuard) return;
    try {
      await this.runtimeGuard(context);
    } catch {
      throw fail(
        409,
        'TOOL_RUNTIME_INACTIVE',
        '运行已停止、执行权已失效或校验未完成，本次工具写入已撤销；请重新核对运行状态。',
      );
    }
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
      await this.assertRuntime(context);
      const result = await operation(context);
      await this.assertRuntime(context);
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
    void definition;
    return ctx;
  }
  private async decision(definition: ToolDefinition, context: LoadedContext) {
    const ctx = this.scopedContext(definition, context);
    const action = definition.metadata.authorizationAction;
    const personal = action.startsWith('conversation.');
    return decideTool(definition.metadata, {
      permissionMode: ctx.permissionMode,
      approvalGranted: await hasConversationToolGrant(ctx, definition.metadata),
      goalStatus: ctx.goalStatus,
      hasUndo: availableUndo(definition),
      resourceAllowed: authorize(ctx.actor, definition.metadata.authorizationAction, {
        projectId: ctx.projectId,
        ownerUserId: personal ? ctx.actor.userId : (ctx.projectOwnerId ?? ctx.actor.userId),
      }),
    });
  }
  private async allowed(definition: ToolDefinition, ctx: LoadedContext) {
    const decision = await this.decision(definition, ctx);
    if (decision.decision === 'deny') throw fail(403, decision.code, decision.message);
    return decision;
  }
  async catalog(reference: unknown) {
    return (await this.turnCatalog(reference)).tools;
  }

  async turnCatalog(reference: unknown) {
    const parsed = toolCatalogContextSchema.safeParse(reference);
    if (!parsed.success) throw fail(400, 'TOOL_CONTEXT_INVALID', '运行身份无效，请重新打开对话。');
    return this.transaction({ ...parsed.data, callId: 'catalog' }, async (ctx) => {
      const permitted: ToolDefinition[] = [];
      for (const definition of this.definitions.values()) {
        if ((await this.decision(definition, ctx)).decision !== 'deny') permitted.push(definition);
      }
      return {
        permissionMode: ctx.permissionMode,
        tools: permitted.map((definition) => this.describe(definition)),
      };
    });
  }

  private describe(definition: ToolDefinition) {
    return {
      name: definition.metadata.name,
      version: definition.metadata.version,
      effect: definition.metadata.effect,
      description: toolDescription(definition.metadata),
      parameters: z.toJSONSchema(definition.inputSchema, { io: 'input', unrepresentable: 'any' }),
    };
  }

  // Pi保留本地实现。每个模型请求和工具执行仍须分别通过实时目录和执行授权。
  registeredToolDescriptions() {
    return [...this.definitions.values()].map((definition) => this.describe(definition));
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
    if (invocation.status === 'pending_approval') {
      const pending = await replayToolApproval(ctx, invocation.id);
      await this.propagate(ctx, pending.dataLevel, invocation.id);
      return {
        invocationId: invocation.id,
        ...pending,
        undoId: null,
        replayed: true,
        status: 'pending_approval',
      };
    }
    if (!['completed', 'denied'].includes(invocation.status))
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
    if (
      invocation.status === 'denied' &&
      !['approval_rejected', 'approval_stale'].includes(payload.status)
    )
      throw fail(409, 'TOOL_RESULT_EXPIRED', '原调用拒绝回执不完整，不能重新执行，请核对记录。');
    let currentLevel: DataLevel =
      definition.metadata.outputDataLevel === 'dynamic'
        ? 'internal'
        : definition.metadata.outputDataLevel;
    if (definition.metadata.outputDataLevel === 'dynamic' && payload.status === 'completed') {
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
    if (definition.metadata.outputDataLevel === 'dynamic' && payload.status === 'completed') {
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
      'UPDATE tool_invocation SET status=$3::tool_invocation_status,data_level=$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2',
      [
        level,
        invocationId,
        ['approval_rejected', 'approval_stale'].includes(payload.status) ? 'denied' : 'completed',
      ],
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

  private async approvalResolution(
    ctx: LoadedContext,
    source: ApprovedCall,
    dataLevel: DataLevel,
    status: 'approval_rejected' | 'approval_stale',
    reason: string,
  ): Promise<ToolResultEnvelope> {
    const data = approvalResolutionSchema.parse({
      approvalId: source.id,
      executed: false,
      rejected: status === 'approval_rejected',
      reason,
      code: status === 'approval_rejected' ? 'APPROVAL_REJECTED' : 'APPROVED_CALL_STALE',
    });
    const payload = toolStoredPayloadSchema.parse({ status, result: { data, dataLevel } });
    await this.propagate(ctx, dataLevel);
    await ctx.tx.query(
      'INSERT INTO conversation_tool_result(invocation_id,conversation_id,user_id,content_json,data_level) VALUES($1,$2,$3,$4,$5)',
      [source.invocation_id, ctx.conversationId, ctx.actor.userId, payload, dataLevel],
    );
    await ctx.tx.query(
      "UPDATE tool_invocation SET status='denied',data_level=$2,updated_at=clock_timestamp() WHERE id=$1",
      [source.invocation_id, dataLevel],
    );
    await ctx.tx.query(
      "INSERT INTO audit_log(actor_user_id,actor_kind,action,target_type,target_id) VALUES($1,'agent',$2,'tool_invocation',$3)",
      [
        ctx.actor.userId,
        status === 'approval_rejected'
          ? 'tool.approval_rejected_result'
          : 'tool.approval_stale_result',
        source.invocation_id,
      ],
    );
    return {
      invocationId: source.invocation_id,
      data,
      dataLevel,
      undoId: null,
      replayed: false,
      status,
    };
  }

  private async recordContinuationResult(
    ctx: LoadedContext,
    ticketId: string,
    source: ApprovedCall,
    result: ToolResultEnvelope,
  ) {
    const event = conversationEventSchema.parse({
      type: 'approval_resolved',
      payload: {
        approvalId: source.id,
        decisionId: source.decision_id,
        invocationId: source.invocation_id,
        executed: result.status === 'completed',
        status: result.status,
        result: z.json().parse(result.data),
      },
    });
    const counter = (
      await ctx.tx.query<{ last_event_seq: string }>(
        'SELECT last_event_seq FROM conversation WHERE id=$1',
        [ctx.conversationId],
      )
    ).rows[0]!;
    const seq = Number(counter.last_event_seq) + 1;
    if (!Number.isSafeInteger(seq))
      throw fail(409, 'CONVERSATION_SEQUENCE_LIMIT', '对话记录已达上限，请交维护人员核对。');
    const eventId = (
      await ctx.tx.query<{ id: string }>(
        `INSERT INTO conversation_event(run_id,conversation_id,user_id,request_key,seq,content_hash,data_level,type,payload_json)
       VALUES($1,$2,$3,$4,$5,$6,$7,'approval_resolved',$8) RETURNING id`,
        [
          ctx.runId,
          ctx.conversationId,
          ctx.actor.userId,
          ticketId,
          seq,
          approvalContentHash(event),
          result.dataLevel,
          JSON.stringify(event.payload),
        ],
      )
    ).rows[0]!.id;
    await ctx.tx.query('SELECT pg_notify($1,$2)', [
      'cert_board_conversation_events',
      JSON.stringify({ conversationId: ctx.conversationId, eventId, seq }),
    ]);
    await ctx.tx.query(
      `UPDATE run_continuation SET state='tool_recorded',tool_recorded_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE id=$1`,
      [ticketId],
    );
  }

  async resumeApproval(reference: unknown, ticketId: string): Promise<ToolResultEnvelope> {
    const parsed = toolCallContextSchema.safeParse(reference);
    if (!parsed.success || !z.string().uuid().safeParse(ticketId).success)
      throw fail(400, 'CONTINUATION_INPUT_INVALID', '继续请求必须使用原运行与原工具调用编号。');
    if (!this.runtimeGuard)
      throw fail(
        403,
        'CONTINUATION_RUNTIME_REQUIRED',
        '批准调用只能由持有真实执行权的Agent内核继续。',
      );
    return this.transaction(parsed.data, async (ctx) => {
      const source = (
        await ctx.tx.query<ApprovedCall>(
          `SELECT a.*,d.id AS decision_id,d.action AS decision_action,d.content_hash AS decision_hash,d.source_version,d.reason AS rejection_reason,
         t.state AS ticket_state,t.claimed_generation,i.status AS invocation_status
         FROM run_continuation t JOIN tool_approval a ON a.id=t.approval_id
         JOIN tool_approval_decision d ON d.id=t.decision_id AND d.approval_id=a.id
         JOIN tool_invocation i ON i.id=t.invocation_id
         JOIN run r ON r.id=t.run_id
         WHERE t.id=$1 AND t.run_id=$2 AND t.user_id=$3 AND t.conversation_id=$4 AND i.call_id=$5
           AND t.claimed_generation=r.lease_generation
         FOR UPDATE OF t,a,i`,
          [ticketId, ctx.runId, ctx.actor.userId, ctx.conversationId, ctx.callId],
        )
      ).rows[0];
      if (!source || !['claimed', 'tool_recorded'].includes(source.ticket_state))
        throw fail(
          409,
          'CONTINUATION_UNAVAILABLE',
          '继续票据不属于当前执行代次或已进入模型阶段，不能重做工具。',
        );
      if (
        source.project_id !== ctx.projectId ||
        source.goal_id !== ctx.goalId ||
        source.run_id !== ctx.runId ||
        source.conversation_id !== ctx.conversationId ||
        source.user_id !== ctx.actor.userId ||
        source.direction_version !== ctx.directionVersion ||
        source.content_hash !== source.decision_hash ||
        source.version !== source.source_version + 1 ||
        (source.decision_action === 'reject'
          ? source.status !== 'rejected'
          : source.status !== 'approved')
      )
        throw fail(409, 'CONTINUATION_SOURCE_MISMATCH', '原批准决定与运行内容不一致，不能继续。');
      const originalHash = approvalContentHash({
        invocationId: source.invocation_id,
        runId: source.run_id,
        conversationId: source.conversation_id,
        userId: source.user_id,
        projectId: source.project_id,
        goalId: source.goal_id,
        toolName: source.tool_name,
        toolVersion: source.tool_version,
        argumentsHash: source.arguments_hash,
        preview: source.preview_json,
        targetVersions: source.target_versions_json,
        directionVersion: source.direction_version,
        dataLevel: source.data_level,
      });
      const argumentsHash = approvalContentHash({
        operation: 'execute',
        name: source.tool_name,
        version: source.tool_version,
        args: source.arguments_json,
      });
      if (originalHash !== source.content_hash || argumentsHash !== source.arguments_hash)
        throw fail(409, 'CONTINUATION_CONTENT_MISMATCH', '原批准参数或内容摘要不一致，不能执行。');
      if (source.ticket_state === 'tool_recorded') {
        const saved = (
          await ctx.tx.query<{
            content_json: unknown;
            data_level: DataLevel;
            undo_id: string | null;
          }>(
            `SELECT p.content_json,p.data_level,u.id AS undo_id FROM conversation_tool_result p LEFT JOIN undo_record u ON u.invocation_id=p.invocation_id
           WHERE p.invocation_id=$1 AND p.conversation_id=$2 AND p.user_id=$3`,
            [source.invocation_id, ctx.conversationId, ctx.actor.userId],
          )
        ).rows[0];
        if (!saved || !['completed', 'denied'].includes(source.invocation_status))
          throw fail(409, 'CONTINUATION_RECEIPT_MISSING', '原调用回执不完整，不能重新执行。');
        const payload = toolStoredPayloadSchema.parse(saved.content_json);
        const dataLevel = highest(
          ctx.maxDataLevel,
          source.data_level,
          saved.data_level,
          payload.result.dataLevel,
        );
        await this.propagate(ctx, dataLevel);
        return {
          invocationId: source.invocation_id,
          data: payload.result.data,
          dataLevel,
          undoId: saved.undo_id,
          replayed: true,
          status: payload.status,
        };
      }
      if (source.invocation_status !== 'pending_approval')
        throw fail(409, 'CONTINUATION_CALL_STATE', '原调用已经改变，不能再次执行。');
      let result: ToolResultEnvelope;
      let level = highest(ctx.maxDataLevel, source.data_level);
      if (source.decision_action === 'reject') {
        result = await this.approvalResolution(
          ctx,
          source,
          level,
          'approval_rejected',
          source.rejection_reason ?? '发起人拒绝了这次操作，请调整做法后再提出。',
        );
      } else {
        const definition = this.definitions.get(source.tool_name);
        let reason: string | undefined;
        let input: { data: unknown } | undefined;
        if (
          !definition ||
          definition.metadata.version !== source.tool_version ||
          definition.metadata.effect !== 'reversible_write' ||
          !definition.metadata.approvalInAsk ||
          !definition.prepareApproval
        )
          reason = '已批准的工具版本或契约已变化，请重新核对后提出新调用。';
        if (definition && !reason) {
          const policy = await this.decision(definition, ctx);
          if (policy.decision === 'deny' || policy.decision === 'propose') reason = policy.message;
          const checked = definition.inputSchema.safeParse(source.arguments_json);
          if (!checked.success)
            reason = '原参数不再符合已批准的工具契约，请重新读取资料后提出新调用。';
          else input = { data: checked.data };
        }
        if (definition && input && !reason) {
          try {
            const preview = toolApprovalPreviewSchema.parse(
              await callback(() => definition.prepareApproval!(ctx, input!.data)),
            );
            const { targetVersions, dataLevel, ...display } = preview;
            level = highest(
              level,
              dataLevel,
              definition.metadata.outputDataLevel === 'dynamic'
                ? 'internal'
                : definition.metadata.outputDataLevel,
            );
            const currentHash = approvalContentHash({
              invocationId: source.invocation_id,
              runId: source.run_id,
              conversationId: source.conversation_id,
              userId: source.user_id,
              projectId: source.project_id,
              goalId: source.goal_id,
              toolName: source.tool_name,
              toolVersion: source.tool_version,
              argumentsHash: source.arguments_hash,
              preview: display,
              targetVersions,
              directionVersion: source.direction_version,
              dataLevel: level,
            });
            if (currentHash !== source.content_hash)
              reason =
                '批准后目标版本、原材料、收件人或数据级别已变化，未执行，请重新读取并提出新调用。';
          } catch (error) {
            if (!(error instanceof ToolBoundaryError) || error.statusCode >= 500) throw error;
            reason = error.message;
          }
        }
        if (reason || !definition || !input) {
          result = await this.approvalResolution(
            ctx,
            source,
            level,
            'approval_stale',
            reason ?? '原批准调用已失效，未执行，请重新提出。',
          );
        } else {
          await ctx.tx.query('SAVEPOINT approved_tool_effect');
          try {
            await ctx.tx.query(
              "UPDATE tool_invocation SET status='started',updated_at=clock_timestamp() WHERE id=$1",
              [source.invocation_id],
            );
            result = await this.perform(ctx, definition, input.data, source.invocation_id, 'allow');
            level = highest(level, result.dataLevel);
            if (level !== source.data_level)
              throw fail(
                409,
                'APPROVAL_LEVEL_CHANGED',
                '执行时发现资料级别变化，已撤回本次写入，请重新核对。',
              );
            await ctx.tx.query('RELEASE SAVEPOINT approved_tool_effect');
          } catch (error) {
            await ctx.tx.query('ROLLBACK TO SAVEPOINT approved_tool_effect');
            await ctx.tx.query('RELEASE SAVEPOINT approved_tool_effect');
            if (!(error instanceof ToolBoundaryError) || error.statusCode >= 500) throw error;
            result = await this.approvalResolution(
              ctx,
              source,
              level,
              'approval_stale',
              error.message,
            );
          }
        }
      }
      await this.recordContinuationResult(ctx, ticketId, source, result);
      return result;
    });
  }

  private async perform(
    ctx: LoadedContext,
    definition: ToolDefinition,
    input: unknown,
    invocationId: string,
    decision: 'allow' | 'propose',
  ): Promise<ToolResultEnvelope> {
    let undoId: string | null = null,
      before: UndoCapture | undefined;
    if (definition.metadata.effect === 'reversible_write') {
      const spec = definition.undo;
      if (!spec) throw fail(403, 'TOOL_UNDO_REQUIRED', '写入工具缺少撤销方式，已拒绝执行。');
      const rawCapture = await callback(() => spec.capture(ctx, input));
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
      if (spec.allowNoChange) await ctx.tx.query('SAVEPOINT tool_write');
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
    const status = decision === 'propose' ? 'pending_proposal' : 'completed';
    if (decision === 'propose' && !definition.propose) {
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
        decision === 'propose'
          ? definition.propose!(ctx, input)
          : definition.execute!(ctx, input, before),
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
    if (result.noChange && (!undoId || !definition.undo?.allowNoChange))
      throw fail(500, 'TOOL_OUTPUT_INVALID', '该工具未登记无写入回执，本次操作已撤销。');
    if (undoId && before && definition.undo) {
      const actual = versionToken(
        await callback(() => definition.undo!.currentVersion(ctx, before!)),
      );
      if (result.noChange) {
        if (result.afterVersion || actual !== before.beforeVersion)
          throw fail(500, 'TOOL_WRITE_VERSION_INVALID', '无写入回执的版本已改变，本次操作已撤销。');
        await ctx.tx.query('ROLLBACK TO SAVEPOINT tool_write');
        undoId = null;
      } else if (
        !result.afterVersion ||
        actual !== result.afterVersion ||
        result.afterVersion === before.beforeVersion
      )
        throw fail(
          500,
          'TOOL_WRITE_VERSION_INVALID',
          '写入后版本未推进或与实际业务版本不一致，本次业务写入已撤销。',
        );
      else
        await ctx.tx.query(
          "UPDATE undo_record SET after_version=$1,status='available',updated_at=CURRENT_TIMESTAMP WHERE id=$2",
          [result.afterVersion, undoId],
        );
      if (definition.undo.allowNoChange) await ctx.tx.query('RELEASE SAVEPOINT tool_write');
    }
    return this.complete(
      ctx,
      invocationId,
      definition,
      toolStoredPayloadSchema.parse({ status, result }),
      undoId,
      'tool.executed',
    );
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
      const decision = await this.allowed(definition, ctx);
      const found = await ctx.tx.query<InvocationRow>(
        'SELECT id,tool_name,tool_version,arguments_hash,operation,status,data_level FROM tool_invocation WHERE run_id=$1 AND call_id=$2',
        [ctx.runId, ctx.callId],
      );
      if (found.rows[0])
        return this.replay(ctx, definition, found.rows[0], argumentsHash, 'execute');
      const invocationId = await this.startInvocation(ctx, definition, argumentsHash, 'execute');
      if (decision.decision === 'require_approval') {
        if (!definition.prepareApproval)
          throw fail(
            500,
            'TOOL_APPROVAL_PREVIEW_REQUIRED',
            '工具缺少可信批准预览，未执行本次操作。',
          );
        const preview = toolApprovalPreviewSchema.parse(
          await callback(() => definition.prepareApproval!(ctx, input.data)),
        );
        const pending = await createToolApproval(
          ctx,
          definition.metadata,
          invocationId,
          argumentsHash,
          json.data,
          preview,
        );
        await this.propagate(ctx, pending.dataLevel);
        return {
          invocationId,
          ...pending,
          undoId: null,
          replayed: false,
          status: 'pending_approval',
        };
      }
      return this.perform(
        ctx,
        definition,
        input.data,
        invocationId,
        decision.decision === 'propose' ? 'propose' : 'allow',
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
      const policy = await this.allowed(definition, ctx);
      if (policy.decision === 'require_approval')
        throw fail(
          403,
          'TOOL_UNDO_APPROVAL_REQUIRED',
          '撤销同样属于业务写入。当前版本不恢复待批准撤销，请先由发起人在浏览器确认权限后处理。',
        );
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
