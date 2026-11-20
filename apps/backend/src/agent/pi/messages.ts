import type { AssistantMessage, Message, Model, ToolCall, Usage } from '@earendil-works/pi-ai';
import type { GatewayResponse, RuntimeModelConfig } from '@cert-board/shared';
import type { KernelMessage } from './types.js';

export function hasCompleteToolHistory(messages: readonly KernelMessage[]): boolean {
  const pending = new Set<string>();
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool') {
      if (!pending.delete(message.tool_call_id)) return false;
      continue;
    }
    if (pending.size) return false;
    if (message.role !== 'assistant') continue;
    for (const call of message.tool_calls ?? []) {
      if (seen.has(call.id)) return false;
      seen.add(call.id);
      pending.add(call.id);
    }
  }
  return pending.size === 0;
}

export const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
export function piModel(config: RuntimeModelConfig): Model<'openai-completions'> {
  if (config.baseUrl === null) throw new Error('MODEL_LOCAL_ENDPOINT_MISSING');
  return {
    id: config.upstreamModel,
    name: config.id,
    api: 'openai-completions',
    provider: 'model-gateway',
    baseUrl: config.baseUrl,
    input: ['text'],
    reasoning: false,
    contextWindow: config.contextLength,
    maxTokens: config.maxOutputTokens,
    cost: {
      input: Number(config.prices.inputUsdPerMillion),
      output: Number(config.prices.outputUsdPerMillion),
      cacheRead: Number(config.prices.cacheReadUsdPerMillion),
      cacheWrite: Number(config.prices.inputUsdPerMillion),
    },
  };
}
export function parseToolArguments(text: string): Pick<ToolCall, 'arguments' | 'argumentsError'> {
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return { arguments: value as ToolCall['arguments'] };
  } catch {
    return { arguments: {}, argumentsError: '工具参数必须是完整的JSON对象，请修正后重试。' };
  }
}
export function toPiMessage(
  message: KernelMessage,
  model: Model<'openai-completions'>,
  toolNames: ReadonlyMap<string, string>,
): Message {
  if (message.role === 'system' || message.role === 'user')
    return { ...message, timestamp: Date.now() };
  if (message.role === 'tool')
    return {
      role: 'toolResult',
      toolCallId: message.tool_call_id,
      toolName: toolNames.get(message.tool_call_id) ?? 'historical_tool',
      content: [{ type: 'text', text: message.content }],
      isError: false,
      timestamp: Date.now(),
    };
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    usage: emptyUsage(),
    stopReason: message.tool_calls?.length ? 'toolUse' : 'stop',
    content: [
      ...(message.content === null ? [] : [{ type: 'text' as const, text: message.content }]),
      ...(message.tool_calls ?? []).map((call): ToolCall => ({
        type: 'toolCall',
        id: call.id,
        name: call.function.name,
        ...parseToolArguments(call.function.arguments),
      })),
    ],
  };
}
export function fromPiMessage(message: Message): KernelMessage {
  if (message.role === 'system' || message.role === 'user')
    return {
      role: message.role,
      content:
        typeof message.content === 'string'
          ? message.content
          : message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
    };
  if (message.role === 'toolResult')
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n'),
    };
  const texts = message.content.filter((part) => part.type === 'text').map((part) => part.text);
  const calls = message.content
    .filter((part) => part.type === 'toolCall')
    .map((call) => ({
      id: call.id,
      type: 'function' as const,
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
  return {
    role: 'assistant',
    content: texts.length ? texts.join('') : null,
    ...(calls.length ? { tool_calls: calls } : {}),
  };
}
export function responseUsage(response: GatewayResponse): Usage {
  const usage = response.usage;
  if (!usage) return emptyUsage();
  return {
    input: usage.inputTokens - usage.cacheReadTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheWrite: 0,
    totalTokens: usage.totalTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: Number(usage.costNano) / 1e9,
    },
  };
}
export function assistantMessage(model: Model<'openai-completions'>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: 'pending',
    timestamp: Date.now(),
  };
}
