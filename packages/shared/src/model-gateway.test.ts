import { describe, expect, it } from 'vitest';
import {
  assistantMessageSchema,
  chatRequestSchema,
  gatewayResponseSchema,
  modelGatewayConfigSchema,
  upstreamAssistantResponseSchema,
  upstreamUsageSchema,
} from './model-gateway.js';

const call = {
  id: 'call_1',
  type: 'function',
  function: { name: 'read_document', arguments: '{"page":1}' },
};
describe('模型网关边界', () => {
  it('合法工具调用回复可以省略content，且未知上游扩展被剔除', () => {
    const result = upstreamAssistantResponseSchema.parse({
      id: 'response-1',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', tool_calls: [call], reasoning: '不输出的上游扩展' },
          finish_reason: 'tool_calls',
        },
      ],
      provider: 'extra',
    });
    expect(result.choices[0]?.message.content).toBeNull();
    expect(result.choices[0]?.message).not.toHaveProperty('reasoning');
    expect(result).not.toHaveProperty('provider');
    expect(
      upstreamAssistantResponseSchema.safeParse({
        id: 'x',
        choices: [{ index: 0, message: { role: 'assistant' }, finish_reason: 'stop' }],
      }).success,
    ).toBe(false);
  });
  it('用量可先独立读取，不能把坏消息导致的拒绝当作零费用', () => {
    const raw = {
      usage: {
        prompt_tokens: 20,
        completion_tokens: 3,
        total_tokens: 23,
        cost: '0.00000441',
        prompt_tokens_details: { cached_tokens: 5, ignored: true },
      },
      choices: [],
    };
    expect(upstreamUsageSchema.parse(raw.usage).cost).toBe('0.00000441');
    expect(upstreamAssistantResponseSchema.safeParse(raw).success).toBe(false);
    expect(
      upstreamUsageSchema.safeParse({
        prompt_tokens: 1,
        completion_tokens: 1,
        prompt_tokens_details: { cached_tokens: 2 },
      }).success,
    ).toBe(false);
    expect(upstreamUsageSchema.safeParse({ prompt_tokens: 1 }).success).toBe(false);
    expect(
      upstreamUsageSchema.safeParse({ prompt_tokens: 1, completion_tokens: 1, cost: Number.NaN })
        .success,
    ).toBe(false);
  });
  it('请求只接受已开放的文本协议，不能覆盖上游或启用不支持的tool_choice', () => {
    const request = { messages: [{ role: 'user', content: '检查资料' }] };
    expect(chatRequestSchema.safeParse(request).success).toBe(true);
    for (const extra of [
      { provider: {} },
      { apiKey: 'fixture' },
      { stream: true },
      { tool_choice: 'required' },
    ])
      expect(chatRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    expect(
      chatRequestSchema.safeParse({
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'https://example.test/image' } }],
          },
        ],
      }).success,
    ).toBe(false);
    const tool = {
      type: 'function',
      function: { name: 'read_document', description: '读取资料', parameters: { type: 'object' } },
    };
    expect(chatRequestSchema.safeParse({ ...request, tools: [tool, tool] }).success).toBe(false);
  });
  it('兼容真实OpenRouter工具调用的数字index，其他未知字段仍拒绝', () => {
    const call = {
      id: 'call_fixture',
      type: 'function',
      index: 0,
      function: { name: 'probe_read', arguments: '{"label":"connected"}' },
    };
    expect(
      assistantMessageSchema.safeParse({ role: 'assistant', content: null, tool_calls: [call] })
        .success,
    ).toBe(true);
    expect(
      assistantMessageSchema.safeParse({
        role: 'assistant',
        content: null,
        tool_calls: [{ ...call, index: 'body' }],
      }).success,
    ).toBe(false);
    expect(
      assistantMessageSchema.safeParse({
        role: 'assistant',
        content: null,
        tool_calls: [{ ...call, secret: 'fixture' }],
      }).success,
    ).toBe(false);
  });
  it('输出仅含规范化业务字段，不能附带上游原始正文或凭据', () => {
    const response = {
      requestKey: '10000000-0000-4000-8000-000000000001',
      model: 'qwen-flash',
      upstreamModel: 'qwen/qwen3.8-flash',
      message: { role: 'assistant', content: '结果' },
      finishReason: 'stop',
      usage: {
        inputTokens: 1,
        cacheReadTokens: 0,
        outputTokens: 1,
        totalTokens: 2,
        costNano: '620',
      },
      dataLevel: 'internal',
    };
    expect(gatewayResponseSchema.safeParse(response).success).toBe(true);
    expect(
      gatewayResponseSchema.safeParse({ ...response, rawResponse: { headers: 'fixture' } }).success,
    ).toBe(false);
    expect(
      modelGatewayConfigSchema.safeParse({ version: 1, models: [], apiKey: 'fixture' }).success,
    ).toBe(false);
  });
});
