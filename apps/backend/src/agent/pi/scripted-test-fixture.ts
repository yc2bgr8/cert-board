import { randomUUID } from 'node:crypto';
import type { ChatRequest, GatewayResponse, RuntimeModelConfig } from '@cert-board/shared';
import type { AgentKernelOptions, KernelTool } from './types.js';

const model: RuntimeModelConfig = {
  id: 'scripted',
  upstreamModel: 'scripted/model',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKeyEnv: 'OPENROUTER_API_KEY',
  family: 'scripted',
  enabled: true,
  accepted: false,
  purposes: ['agent'],
  maxDataLevel: 'internal',
  contextLength: 100000,
  maxOutputTokens: 1024,
  supportsImages: false,
  prices: { inputUsdPerMillion: '0.1', cacheReadUsdPerMillion: '0.05', outputUsdPerMillion: '0.2' },
  provider: { only: ['fixture'], allow_fallbacks: false, require_parameters: true },
  reasoning: { enabled: false },
};
export const toolCall = (name: string, args: string = '{}', id: string = randomUUID()) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: args },
});
export const reply = (...calls: ReturnType<typeof toolCall>[]): GatewayResponse['message'] =>
  calls.length
    ? { role: 'assistant', content: null, tool_calls: calls }
    : { role: 'assistant', content: '已完成。' };
export function scripted(messages: GatewayResponse['message'][]) {
  const requests: ChatRequest[] = [];
  const complete: AgentKernelOptions['complete'] = async (request, context) => {
    const message = messages[requests.length];
    if (!message) throw new Error('剧本没有后续响应');
    requests.push(request);
    return {
      requestKey: context.requestKey,
      model: 'scripted',
      upstreamModel: model.upstreamModel,
      message,
      finishReason: message.tool_calls?.length ? 'tool_calls' : 'stop',
      dataLevel: 'internal',
      usage: {
        inputTokens: 100,
        cacheReadTokens: 20,
        outputTokens: 10,
        totalTokens: 110,
        costNano: String(requests.length * 1000),
      },
    };
  };
  return { complete, requests };
}
export function tool(
  name: string,
  execute: KernelTool['execute'] = async () => ({ data: { ok: true } }),
): KernelTool {
  return {
    name,
    description: '仅本地剧本测试工具，按输入执行受控回调。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute,
  };
}
export function options(
  complete: AgentKernelOptions['complete'],
  tools: KernelTool[] = [],
): AgentKernelOptions {
  return {
    systemPrompt: '先读项目说明和技能，列计划、执行、自查，再提交审核。',
    history: [],
    messages: [{ role: 'user', content: '核对示例写法。' }],
    model,
    tools,
    complete,
    signal: new AbortController().signal,
  };
}
