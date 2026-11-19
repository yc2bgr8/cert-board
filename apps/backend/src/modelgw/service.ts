import type { Pool } from 'pg';
import {
  modelGatewayConfigSchema,
  chatRequestSchema,
  gatewayContextSchema,
  upstreamUsageSchema,
  upstreamAssistantResponseSchema,
  gatewayResponseSchema,
  type ModelGatewayConfig,
  type GatewayModelConfig,
  type ChatRequest,
  type GatewayContext,
  type GatewayResponse,
  type DataLevel,
  type UpstreamUsage,
  type BudgetIncomplete,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import {
  reserveUsage,
  settleUsage,
  markUsageIncomplete,
  markUsageNotDispatched,
  meteringCanResume,
} from '../budget/service.js';

export type UpstreamChatRequest = Omit<ChatRequest, 'model' | 'stream'> & {
  model: string;
  stream: false;
  max_tokens: number;
  provider: GatewayModelConfig['provider'] & { max_price: { prompt: number; completion: number } };
  reasoning: GatewayModelConfig['reasoning'];
};
export interface GatewayTransport {
  readonly kind: 'real' | 'fixture';
  send(
    model: GatewayModelConfig,
    body: UpstreamChatRequest,
    signal?: AbortSignal,
  ): Promise<unknown>;
}
type GatewayOptions = { environment?: 'development' | 'test' | 'production' };
const rejected = (code: string, message: string, status = 403) =>
  new AppError(status, code, message);
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// 上游数字可能采用科学记数法；转成整数nano时只使用十进制字符串与BigInt并向上取整。
function providerCostNano(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) return undefined;
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match) return undefined;
  const fraction = match[2] ?? '',
    exponent = Number(match[3] ?? 0);
  if (
    !Number.isSafeInteger(exponent) ||
    Math.abs(exponent) > 30 ||
    match[1]!.length + fraction.length > 80
  )
    return undefined;
  const digits = BigInt(match[1]! + fraction),
    scale = fraction.length - exponent;
  const nano =
    scale <= 9
      ? digits * 10n ** BigInt(9 - scale)
      : (digits + 10n ** BigInt(scale - 9) - 1n) / 10n ** BigInt(scale - 9);
  if (nano > 999999999999999999n) return undefined;
  return nano.toString();
}

export class ModelGateway {
  private readonly config: ModelGatewayConfig;
  private readonly environment: string;
  private readonly meteringBlocks = new Map<string, string | null>();
  constructor(
    private readonly pool: Pool,
    config: unknown,
    private readonly transport: GatewayTransport,
    options: GatewayOptions = {},
  ) {
    const parsed = modelGatewayConfigSchema.safeParse(config);
    if (!parsed.success)
      throw rejected(
        'MODEL_CONFIG_INVALID',
        '模型配置无效，请维护人员核对已启用模型、价格与上游设置。',
        500,
      );
    this.config = frozen(parsed.data);
    this.environment = options.environment ?? process.env.NODE_ENV ?? 'production';
    if (process.env.NODE_ENV === 'production' && this.environment !== 'production')
      throw rejected('MODEL_ENVIRONMENT_DOWNGRADE', '生产进程不能降级为开发或测试环境。');
    if (!['development', 'test', 'production'].includes(this.environment))
      throw rejected('MODEL_ENVIRONMENT_INVALID', '模型运行环境无效，已拒绝启动。', 500);
    if (!['real', 'fixture'].includes(transport.kind))
      throw rejected('MODEL_TRANSPORT_INVALID', '模型传输实现未登记。', 500);
    if (
      transport.kind === 'fixture' &&
      (this.environment !== 'test' || process.env.NODE_ENV !== 'test')
    )
      throw rejected(
        'MODEL_FIXTURE_FORBIDDEN',
        '剧本测试上游只能用于测试环境，不能替代真实对话模型。',
      );
  }

  private choose(request: ChatRequest, context: GatewayContext) {
    const candidates = this.config.models.filter(
      (model) =>
        model.enabled &&
        model.purposes.includes(context.purpose) &&
        (!request.model || model.id === request.model),
    );
    const model = candidates[0];
    if (!model)
      throw rejected('MODEL_UNAVAILABLE', '当前用途没有已启用的模型，请维护人员核对配置。');
    if (this.environment === 'production' && !model.accepted)
      throw rejected('MODEL_NOT_ACCEPTED', '该模型尚未通过正式验收，不能在生产环境使用。');
    return model;
  }

  private async routing(context: GatewayContext) {
    const result = await this.pool.query<{
      conversation_id: string;
      user_id: string;
      project_id: string | null;
      goal_id: string | null;
      status: string;
      conversation_user: string;
      conversation_project: string | null;
      conversation_goal: string | null;
      conversation_status: string;
      user_status: string;
      data_level: DataLevel;
    }>(
      `SELECT r.conversation_id,r.user_id,r.project_id,r.goal_id,r.status,c.user_id AS conversation_user,
      c.project_id AS conversation_project,c.goal_id AS conversation_goal,c.status AS conversation_status,u.status AS user_status,
      GREATEST(r.max_data_level,c.max_data_level,COALESCE(w.data_level,'internal'::document_data_level),
        COALESCE((SELECT wd.data_level FROM workspace_draft wd WHERE wd.conversation_id=c.id),'internal'::document_data_level),
        COALESCE((SELECT v.data_level FROM document d JOIN document_version v ON v.document_id=d.id WHERE d.project_id=r.project_id ORDER BY v.data_level DESC LIMIT 1),'internal'::document_data_level)) AS data_level
      FROM run r JOIN conversation c ON c.id=r.conversation_id JOIN app_user u ON u.id=r.user_id
      LEFT JOIN workspace w ON w.project_id=r.project_id WHERE r.id=$1`,
      [context.runId],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.user_id !== context.userId ||
      row.conversation_id !== context.conversationId ||
      row.conversation_user !== context.userId ||
      row.project_id !== row.conversation_project ||
      row.goal_id !== row.conversation_goal
    )
      throw rejected('MODEL_CONTEXT_FORBIDDEN', '模型请求的运行、对话或用户归属不一致。');
    if (
      row.status !== 'running' ||
      row.conversation_status !== 'active' ||
      row.user_status !== 'active'
    )
      throw rejected('MODEL_RUN_INACTIVE', '运行、对话或用户已停止，不能继续调用模型。', 409);
    if (row.data_level === 'confidential')
      throw rejected(
        'MODEL_LOCAL_REQUIRED',
        '当前项目或对话涉及保密资料，尚未配置可用的本地模型；已拒绝向远端发送。',
      );
    return 'internal' as const;
  }

  private usage(raw: unknown): UpstreamUsage | null {
    const source = object(raw);
    if (!source) return null;
    // cost坏了但token完整时仍可按已保存的价格计量，不能因消息格式问题丢账。
    const parsed = upstreamUsageSchema.safeParse({
      prompt_tokens: source.prompt_tokens,
      completion_tokens: source.completion_tokens,
      ...(source.total_tokens !== undefined ? { total_tokens: source.total_tokens } : {}),
      ...(source.prompt_tokens_details !== undefined
        ? { prompt_tokens_details: source.prompt_tokens_details }
        : {}),
      ...(source.completion_tokens_details !== undefined
        ? { completion_tokens_details: source.completion_tokens_details }
        : {}),
    });
    return parsed.success ? parsed.data : null;
  }

  private async account(context: GatewayContext, usage: UpstreamUsage, rawUsage: unknown) {
    const cost = providerCostNano(object(rawUsage)?.cost);
    try {
      const settled = await settleUsage(this.pool, {
        requestKey: context.requestKey,
        runId: context.runId,
        userId: context.userId,
        inputTokens: usage.prompt_tokens,
        cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
        outputTokens: usage.completion_tokens,
        ...(cost !== undefined ? { actualCostNano: cost } : {}),
      });
      return settled.actualNano;
    } catch {
      await this.recordIncomplete(context, 'provider_error').catch(() => undefined);
      throw rejected(
        'MODEL_METERING_FAILED',
        '费用登记未完成，本网关已停止继续派发；请核对持久账本，不要重发模型请求。',
        503,
      );
    }
  }
  private async recordIncomplete(
    context: GatewayContext,
    reasonCode: BudgetIncomplete['reasonCode'],
  ) {
    this.meteringBlocks.set(context.requestKey, null);
    const recorded = await markUsageIncomplete(this.pool, {
      requestKey: context.requestKey,
      runId: context.runId,
      userId: context.userId,
      reasonCode,
    });
    this.meteringBlocks.set(context.requestKey, recorded.id);
  }

  private async refreshMeteringBlocks() {
    if (!this.meteringBlocks.size) return;
    const checked = [...this.meteringBlocks];
    const ids = checked.map(([, id]) => id);
    // 登记本身失效时，保留进程内拦截。
    if (!ids.every((id): id is string => id !== null)) return;
    if (!(await meteringCanResume(this.pool, ids, this.environment).catch(() => false))) return;
    for (const [requestKey, ledgerId] of checked) {
      if (this.meteringBlocks.get(requestKey) === ledgerId) this.meteringBlocks.delete(requestKey);
    }
  }

  private async incomplete(
    context: GatewayContext,
    reasonCode: 'missing_usage' | 'request_uncertain' | 'aborted',
  ) {
    try {
      await this.recordIncomplete(context, reasonCode);
    } catch {
      throw rejected(
        'MODEL_METERING_FAILED',
        '未知费用无法登记，本网关已停止继续派发；请核对持久账本。',
        503,
      );
    }
  }

  async complete(
    requestInput: unknown,
    contextInput: unknown,
    signal?: AbortSignal,
    beforeDispatch?: () => Promise<void>,
  ): Promise<GatewayResponse> {
    if (this.meteringBlocks.size) await this.refreshMeteringBlocks();
    if (this.meteringBlocks.size)
      throw rejected(
        'MODEL_METERING_BLOCKED',
        '本网关存在未完成计量，已禁止再次派发，请负责人核对账本后处理。',
      );
    const requestResult = chatRequestSchema.safeParse(requestInput),
      contextResult = gatewayContextSchema.safeParse(contextInput);
    if (!requestResult.success || !contextResult.success)
      throw rejected(
        'MODEL_INPUT_INVALID',
        '模型请求不符合文本聊天与工具调用契约，请检查消息、用途和运行身份。',
        400,
      );
    if (signal?.aborted) throw rejected('MODEL_ABORTED', '运行已停止，未发出模型请求。', 409);
    const request = requestResult.data,
      context = contextResult.data,
      model = this.choose(request, context);
    const requested = request.max_tokens ?? model.maxOutputTokens;
    if (requested > model.maxOutputTokens)
      throw rejected('MODEL_OUTPUT_LIMIT', '请求输出上限超过该模型配置，请缩小输出范围。', 400);
    const { model: _alias, stream: _stream, ...rest } = request;
    const body: UpstreamChatRequest = {
      ...rest,
      model: model.upstreamModel,
      max_tokens: requested,
      stream: false,
      provider: {
        ...model.provider,
        max_price: {
          prompt: Number(model.prices.inputUsdPerMillion),
          completion: Number(model.prices.outputUsdPerMillion),
        },
      },
      reasoning: model.reasoning,
    };
    const size = Buffer.byteLength(JSON.stringify(body), 'utf8');
    if (size > 256 * 1024)
      throw rejected(
        'MODEL_INPUT_LIMIT',
        '本切片文本请求最多256KiB，请缩小读取范围或压缩历史后重试。',
        413,
      );
    const estimatedInputTokens = size + request.messages.length * 64 + 256;
    const maxOutputTokens = requested + Math.max(256, Math.ceil(requested * 0.1));
    if (estimatedInputTokens + maxOutputTokens > model.contextLength)
      throw rejected(
        'MODEL_CONTEXT_LIMIT',
        '请求的保守token上界超过模型上下文，请缩小资料或历史后重试。',
        413,
      );
    await this.routing(context);
    const reservation = await reserveUsage(this.pool, {
      requestKey: context.requestKey,
      runId: context.runId,
      userId: context.userId,
      modelId: model.upstreamModel,
      purpose: context.purpose,
      estimatedInputTokens,
      maxOutputTokens,
      prices: model.prices,
    });
    if (!reservation.dispatchAllowed || !reservation.newReservation)
      throw rejected(
        'MODEL_REQUEST_ALREADY_RESERVED',
        '该模型请求已预占或已有回执，不会再次派发；请核对运行记录后处理。',
        409,
      );
    // 预占后再次检查源级别，旧会话不能利用窗口或历史缓存绕过项目升密。
    try {
      await this.routing(context);
      if (signal?.aborted) throw rejected('MODEL_ABORTED', '运行已停止，未继续发出模型请求。', 409);
    } catch (error) {
      await this.incomplete(context, signal?.aborted ? 'aborted' : 'request_uncertain');
      throw error;
    }
    if (beforeDispatch) {
      try {
        await beforeDispatch();
        if (signal?.aborted) throw new Error('dispatch_cancelled');
      } catch {
        // 可信执行权校验发生在send之前，能确定本请求未发出；不能当作未知费用冻结。
        await this.account(context, { prompt_tokens: 0, completion_tokens: 0 }, { cost: '0' });
        throw rejected(
          'MODEL_DISPATCH_BLOCKED',
          '发送前执行权或取消状态未通过校验，请求未发出，预占已按零费用结算；请核对运行状态。',
          409,
        );
      }
    }
    if (this.meteringBlocks.size) {
      try {
        // 仍在 transport.send 之前，可以确定本调用未发送。
        await markUsageNotDispatched(this.pool, context);
      } catch {
        await this.recordIncomplete(context, 'provider_error').catch(() => undefined);
      }
      throw rejected(
        'MODEL_METERING_BLOCKED',
        '本网关已因计量故障停止派发，本请求未发出，请先核对账本。',
      );
    }
    let raw: unknown;
    try {
      raw = await this.transport.send(model, body, signal);
    } catch (error) {
      const rawUsage = object(error)?.usage,
        usage = this.usage(rawUsage);
      if (usage) await this.account(context, usage, rawUsage);
      else await this.incomplete(context, signal?.aborted ? 'aborted' : 'request_uncertain');
      throw rejected(
        signal?.aborted ? 'MODEL_ABORTED' : 'MODEL_UPSTREAM_FAILED',
        usage
          ? '上游请求未成功，已登记返回的用量费用；本次结果不能用于业务操作。'
          : '上游请求未形成完整用量回执，已保留预占并停止追加调用，请核对计量状态。',
        502,
      );
    }
    const rawUsage = object(raw)?.usage,
      usage = this.usage(rawUsage);
    if (!usage) {
      await this.incomplete(context, 'missing_usage');
      throw rejected(
        'MODEL_USAGE_INCOMPLETE',
        '上游未返回完整用量，已保留全部预占并冻结追加调用，请负责人核对。',
        502,
      );
    }
    const costNano = await this.account(context, usage, rawUsage);
    // 已发生的费用到此已入账。停机、取消和坏消息都不能进入后续工具执行。
    if (signal?.aborted)
      throw rejected('MODEL_ABORTED', '运行已停止，用量已登记，不再处理模型输出。', 409);
    const dataLevel = await this.routing(context);
    const response = upstreamAssistantResponseSchema.safeParse(raw);
    if (!response.success)
      throw rejected(
        'MODEL_RESPONSE_INVALID',
        '模型消息或工具调用结构无效，费用已登记，本次输出不能执行。',
        502,
      );
    const choice = response.data.choices[0]!;
    if (choice.finish_reason === 'length' || choice.finish_reason === 'content_filter')
      throw rejected(
        'MODEL_RESPONSE_INCOMPLETE',
        '模型输出未完整结束或被上游拦截，费用已登记，请缩小任务后重新运行。',
        502,
      );
    return gatewayResponseSchema.parse({
      requestKey: context.requestKey,
      model: model.id,
      upstreamModel: model.upstreamModel,
      message: choice.message,
      finishReason: choice.finish_reason,
      dataLevel,
      usage: {
        inputTokens: usage.prompt_tokens,
        cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
        outputTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens,
        costNano,
      },
    });
  }
}
