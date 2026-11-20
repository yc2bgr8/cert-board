import { z } from 'zod';
import { budgetPricesSchema, decimalUsdSchema, nanoAmountSchema } from './budget.js';

const id = z.string().uuid('模型调用身份编号无效。');
const count = z.number().int().nonnegative().safe();
const modelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/, '模型编号格式无效。');
const purpose = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, '模型用途格式无效。');
const toolName = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, '工具名称格式无效。');
const callId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const textContent = z
  .string()
  .max(262144)
  .refine((text) => /^[^\uD800-\uDFFF]*$/u.test(text), '模型文本包含不完整字符。');

const gatewayModelFields = {
  id: modelId,
  upstreamModel: modelId,
  family: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  enabled: z.boolean(),
  accepted: z.boolean(),
  purposes: z
    .array(purpose)
    .min(1)
    .max(16)
    .refine((values) => new Set(values).size === values.length, '模型用途不能重复。'),
  contextLength: count.positive(),
  maxOutputTokens: count.positive(),
  supportsImages: z.literal(false, { error: '本切片仅启用文本输入。' }),
  prices: budgetPricesSchema,
  reasoning: z.object({ enabled: z.literal(false) }).strict(),
};

export const openRouterGatewayModelSchema = z
  .object({
    ...gatewayModelFields,
    transport: z.literal('openrouter').optional(),
    developmentOnly: z.literal(true).optional(),
    baseUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          (!url.port || url.port === '443')
        );
      }, '模型上游必须使用无凭据、无查询参数的 HTTPS 地址。'),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,62}_KEY$/, '只能填写模型密钥的环境变量名称，不能填写密钥值。'),
    maxDataLevel: z.literal('internal', { error: '当前远端上游最多处理内部资料。' }),
    reasoning: z.union([
      z.object({ enabled: z.literal(false) }).strict(),
      z.object({ enabled: z.literal(true), exclude: z.literal(true) }).strict(),
    ]),
    provider: z
      .object({
        only: z
          .array(z.string().regex(/^[a-z0-9][a-z0-9_./-]{0,127}$/))
          .min(1)
          .max(8)
          .refine((values) => new Set(values).size === values.length, '提供方不能重复。'),
        allow_fallbacks: z.literal(false),
        require_parameters: z.literal(true),
        data_collection: z.literal('deny').optional(),
        zdr: z.literal(true).optional(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (model) =>
      !model.reasoning.enabled ||
      (model.developmentOnly === true &&
        model.provider.zdr === true &&
        model.provider.data_collection === 'deny'),
    '远端推理须是开发期限定模型，并启用零保留与拒绝数据收集。',
  );

export function isLocalGatewayEndpoint(value: string) {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['/v1', '/v1/'].includes(url.pathname) ||
    url.port === '0'
  )
    return false;
  const octets = url.hostname.split('.');
  if (octets.length !== 4 || octets.some((part) => !/^[0-9]{1,3}$/u.test(part))) return false;
  const [first, second] = octets.map(Number);
  return (
    url.hostname === '127.0.0.1' ||
    first === 10 ||
    (first === 172 && second! >= 16 && second! <= 31) ||
    (first === 192 && second === 168)
  );
}

export const localGatewayModelSchema = z
  .object({
    ...gatewayModelFields,
    transport: z.literal('local'),
    baseUrl: z
      .string()
      .refine(isLocalGatewayEndpoint, '本地模型只接受内网 IPv4 的 OpenAI 兼容 /v1 地址。')
      .nullable(),
    maxDataLevel: z.literal('confidential'),
    prices: budgetPricesSchema.refine(
      (value) => Object.values(value).every((price) => Number(price) === 0),
      '本地模型不计美元费用。',
    ),
  })
  .strict();

export const gatewayModelConfigSchema = z
  .union([openRouterGatewayModelSchema, localGatewayModelSchema])
  .refine((model) => model.maxOutputTokens <= model.contextLength, '输出上限不能超过上下文上限。');
export type OpenRouterGatewayModel = z.infer<typeof openRouterGatewayModelSchema>;
export type LocalGatewayModel = z.infer<typeof localGatewayModelSchema>;
export type GatewayModelConfig = z.infer<typeof gatewayModelConfigSchema>;
export type RuntimeModelConfig = GatewayModelConfig;
export const modelGatewayConfigSchema = z
  .object({
    version: z.literal(1),
    developmentDefault: modelId.optional(),
    models: z.array(gatewayModelConfigSchema).min(1).max(16),
  })
  .strict()
  .refine(
    (config) => new Set(config.models.map((model) => model.id)).size === config.models.length,
    '模型配置编号不能重复。',
  );
export type ModelGatewayConfig = z.infer<typeof modelGatewayConfigSchema>;

export function selectGatewayModel(
  config: ModelGatewayConfig,
  purpose: string,
  requested?: string,
) {
  const candidates = config.models.filter(
    (model) =>
      model.enabled &&
      model.baseUrl !== null &&
      model.purposes.includes(purpose) &&
      (!requested || model.id === requested),
  );
  return (
    candidates.find((model) => model.transport === 'local') ??
    candidates.find((model) => model.id === config.developmentDefault) ??
    candidates[0]
  );
}

const toolCallFields = {
  id: callId,
  index: count.optional(),
  type: z.literal('function'),
  function: z.object({ name: toolName, arguments: z.string().max(64000) }).strict(),
};
export const chatToolCallSchema = z.object(toolCallFields).strict();
const assistantFields = {
  role: z.literal('assistant'),
  content: textContent.nullable().default(null),
  tool_calls: z.array(chatToolCallSchema).min(1).max(32).optional(),
};
export const assistantMessageSchema = z
  .object(assistantFields)
  .strip()
  .refine(
    (message) => message.content !== null || Boolean(message.tool_calls?.length),
    '模型必须提供文本或工具调用。',
  );
export const chatMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: textContent }).strict(),
  z.object({ role: z.literal('user'), content: textContent }).strict(),
  z.object(assistantFields).strict(),
  z.object({ role: z.literal('tool'), content: textContent, tool_call_id: callId }).strict(),
]);
export type ChatMessage = z.infer<typeof chatMessageSchema>;
const toolDefinitionSchema = z
  .object({
    type: z.literal('function'),
    function: z
      .object({
        name: toolName,
        description: z.string().min(1).max(6000),
        parameters: z
          .record(z.string(), z.json())
          .refine((value) => JSON.stringify(value).length <= 32000, '工具参数模式过长。'),
      })
      .strict(),
  })
  .strict();
export const chatRequestSchema = z
  .object({
    model: modelId.optional(),
    messages: z.array(chatMessageSchema).min(1).max(256),
    tools: z.array(toolDefinitionSchema).max(64).optional(),
    tool_choice: z.enum(['auto', 'none']).optional(),
    max_tokens: count.positive().optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    stream: z.literal(false, { error: '本切片尚未开放流式模型接口。' }).optional(),
  })
  .strict()
  .refine(
    (request) =>
      !request.tools ||
      new Set(request.tools.map((tool) => tool.function.name)).size === request.tools.length,
    '工具目录包含重复名称。',
  )
  .refine(
    (request) =>
      request.messages.every(
        (message) =>
          message.role !== 'assistant' ||
          message.content !== null ||
          Boolean(message.tool_calls?.length),
      ),
    '历史助手消息必须包含文本或工具调用。',
  );
export type ChatRequest = z.infer<typeof chatRequestSchema>;
export const gatewayContextSchema = z
  .object({ requestKey: id, runId: id, conversationId: id, userId: id, purpose })
  .strict();
export type GatewayContext = z.infer<typeof gatewayContextSchema>;

// 先独立核对并结算用量；后续消息不合格也不能丢弃已经发生的费用。
export const upstreamUsageSchema = z
  .object({
    prompt_tokens: count,
    completion_tokens: count,
    total_tokens: count.optional(),
    cost: z.union([z.number().finite().nonnegative(), decimalUsdSchema]).nullable().optional(),
    prompt_tokens_details: z
      .object({ cached_tokens: count.optional() })
      .strip()
      .nullable()
      .optional(),
    completion_tokens_details: z
      .object({ reasoning_tokens: count.optional() })
      .strip()
      .nullable()
      .optional(),
  })
  .strip()
  .superRefine((usage, context) => {
    if ((usage.prompt_tokens_details?.cached_tokens ?? 0) > usage.prompt_tokens)
      context.addIssue({ code: 'custom', message: '缓存 token 不能多于输入 token。' });
    if (
      usage.total_tokens !== undefined &&
      usage.total_tokens < usage.prompt_tokens + usage.completion_tokens
    )
      context.addIssue({ code: 'custom', message: '总 token 数小于输入和输出合计。' });
  });
export type UpstreamUsage = z.infer<typeof upstreamUsageSchema>;
const finishReason = z.enum(['stop', 'length', 'tool_calls', 'content_filter']);
export const upstreamAssistantResponseSchema = z
  .object({
    id: z.string().min(1).max(200),
    object: z.literal('chat.completion').optional(),
    created: count.optional(),
    model: z.string().min(1).max(200).optional(),
    choices: z
      .array(
        z
          .object({
            index: z.literal(0),
            message: assistantMessageSchema,
            finish_reason: finishReason,
          })
          .strip(),
      )
      .length(1),
  })
  .strip();
export const gatewayResponseSchema = z
  .object({
    requestKey: id,
    model: modelId,
    upstreamModel: modelId,
    message: assistantMessageSchema,
    finishReason,
    usage: z
      .object({
        inputTokens: count,
        cacheReadTokens: count,
        outputTokens: count,
        totalTokens: count,
        costNano: nanoAmountSchema.nullable(),
      })
      .strict()
      .nullable(),
    dataLevel: z.enum(['internal', 'confidential']),
  })
  .strict();
export type GatewayResponse = z.infer<typeof gatewayResponseSchema>;
