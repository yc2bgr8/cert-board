import { randomUUID } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import type { ChatRequest, GatewayResponse, RuntimeModelConfig } from '@cert-board/shared';
import {
  runAgentKernel,
  KernelToolError,
  type AgentKernelOptions,
  type KernelEvent,
  type KernelTool,
  type KernelUsage,
} from './kernel.js';

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
const toolCall = (name: string, args: string = '{}', id: string = randomUUID()) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: args },
});
const reply = (...calls: ReturnType<typeof toolCall>[]): GatewayResponse['message'] =>
  calls.length
    ? { role: 'assistant', content: null, tool_calls: calls }
    : { role: 'assistant', content: '已完成。' };
function scripted(messages: GatewayResponse['message'][]) {
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
function tool(
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
function options(
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
afterEach(() => vi.unstubAllGlobals());

test.each([
  { approval: '允许一次', receipt: { executed: true, status: 'queued' } },
  { approval: '拒绝', receipt: { executed: false, rejected: true, reason: '请先核对登记' } },
])('从原工具回执继续$approval，累计原运行用量且不重做工具', async ({ receipt }) => {
  const source = scripted([reply()]);
  const call = toolCall('queue_internal_message');
  const apply = vi.fn(async () => ({ data: { forged: true } }));
  const metered = vi.fn();
  const result = await runAgentKernel({
    ...options(source.complete, [tool('queue_internal_message', apply)]),
    messages: [],
    history: [
      { role: 'user', content: '核对合成事项。' },
      reply(call),
      { role: 'tool', tool_call_id: call.id, content: JSON.stringify(receipt) },
    ],
    continuation: { initialUsage: { steps: 2, totalTokens: 220, costNano: '3000' } },
    onTurn: metered,
  });
  expect(result.status).toBe('completed');
  expect(source.requests).toHaveLength(1);
  expect(source.requests[0]?.messages.at(-1)).toMatchObject({
    role: 'tool',
    tool_call_id: call.id,
    content: JSON.stringify(receipt),
  });
  expect(apply).not.toHaveBeenCalled();
  expect(metered).toHaveBeenCalledExactlyOnceWith({ steps: 3, totalTokens: 330, costNano: '4000' });
});

test('多轮读写后提交即等待，同批后续工具不执行且归一化prompt/tools进入网关', async () => {
  const source = scripted([
    reply(toolCall('doc_read')),
    reply(toolCall('write_file')),
    reply(toolCall('submit_for_review'), toolCall('late_write')),
  ]);
  const called: string[] = [];
  const events: KernelEvent[] = [];
  const result = await runAgentKernel({
    ...options(
      source.complete,
      ['doc_read', 'write_file', 'submit_for_review', 'late_write'].map((name) =>
        tool(name, async () => {
          called.push(name);
          return { data: { name } };
        }),
      ),
    ),
    onEvent: (event) => {
      events.push(event);
    },
  });
  expect(result.status).toBe('waiting_review');
  expect(called).toEqual(['doc_read', 'write_file', 'submit_for_review']);
  expect(source.requests).toHaveLength(3);
  expect(source.requests[0]?.messages[0]).toMatchObject({
    role: 'system',
    content: expect.stringContaining('先读项目说明'),
  });
  expect(source.requests[0]?.tools?.map((item) => item.function.name)).toEqual([
    'doc_read',
    'write_file',
    'submit_for_review',
    'late_write',
  ]);
  expect(source.requests[1]?.messages.some((message) => message.role === 'tool')).toBe(true);
  expect(events.filter((event) => event.type === 'waiting')).toEqual([
    { type: 'waiting', reason: 'review' },
  ]);
  expect(events.filter((event) => event.type === 'tool_started')).toHaveLength(3);
  expect(result.messages.some((message) => message.role === 'user')).toBe(false);
});

test('同批工具严格串行，每个回调完成后才开始下一个', async () => {
  const sequence: string[] = [];
  const source = scripted([reply(toolCall('first_read'), toolCall('second_read')), reply()]);
  const result = await runAgentKernel(
    options(source.complete, [
      tool('first_read', async () => {
        sequence.push('first-start');
        await Promise.resolve();
        sequence.push('first-end');
        return { data: 'first' };
      }),
      tool('second_read', async () => {
        sequence.push('second');
        return { data: 'second' };
      }),
    ]),
  );
  expect(result.status).toBe('completed');
  expect(sequence).toEqual(['first-start', 'first-end', 'second']);
});

test('过程批准立即暂停，同批后续工具及下一次模型均不得继续', async () => {
  const source = scripted([reply(toolCall('record_update'), toolCall('late_write')), reply()]);
  let lateWrites = 0;
  const events: KernelEvent[] = [];
  const result = await runAgentKernel({
    ...options(source.complete, [
      tool('record_update', async () => ({
        data: { approvalId: randomUUID(), status: 'pending' },
        terminal: 'approval',
      })),
      tool('late_write', async () => {
        lateWrites++;
        return { data: { ok: true } };
      }),
    ]),
    onEvent: (event) => {
      events.push(event);
    },
  });
  expect(result.status).toBe('waiting_approval');
  expect(source.requests).toHaveLength(1);
  expect(lateWrites).toBe(0);
  expect(events.filter((event) => event.type === 'waiting')).toEqual([
    { type: 'waiting', reason: 'approval' },
  ]);
});

test('模式错误给安全中文回执，模型可修复参数再调用', async () => {
  const source = scripted([
    reply(toolCall('read_number', '{"value":"PRIVATE_ARGUMENT"}')),
    reply(toolCall('read_number', '{"value":1}')),
    reply(),
  ]);
  let calls = 0;
  const reader = tool('read_number', async () => {
    calls++;
    return { data: '已读' };
  });
  reader.parameters = {
    type: 'object',
    properties: { value: { type: 'integer' } },
    required: ['value'],
    additionalProperties: false,
  };
  const result = await runAgentKernel(options(source.complete, [reader]));
  expect(result.status).toBe('completed');
  expect(calls).toBe(1);
  const error = source.requests[1]?.messages.find((message) => message.role === 'tool');
  expect(error?.content).toContain('参数未通过工具模式');
  expect(error?.content).not.toContain('PRIVATE_ARGUMENT');
});

test('可修复的提交失败不会误标等待，修正后成功才停止', async () => {
  const source = scripted([
    reply(toolCall('submit_for_review')),
    reply(toolCall('submit_for_review')),
  ]);
  let count = 0;
  const result = await runAgentKernel(
    options(source.complete, [
      tool('submit_for_review', async () => {
        if (++count === 1)
          throw new KernelToolError('REVIEW_READ_REQUIRED', '请先读取完整引语。', {
            recoverable: true,
          });
        return { data: { reviewId: randomUUID() }, terminal: 'review' };
      }),
    ]),
  );
  expect(result.status).toBe('waiting_review');
  expect(count).toBe(2);
});

test.each(['AUTHORIZATION_DENIED', 'READ_ONLY_MODE', 'RUN_LEASE_STALE', 'BUDGET_LIMIT'])(
  '%s是终止错误，同批后续写入不执行',
  async (code) => {
    const source = scripted([reply(toolCall('protected_write'), toolCall('later_write'))]);
    let later = 0;
    const result = await runAgentKernel(
      options(source.complete, [
        tool('protected_write', async () => {
          throw new KernelToolError(code, '当前运行无权继续，请刷新状态。', { recoverable: false });
        }),
        tool('later_write', async () => {
          later++;
          return { data: null };
        }),
      ]),
    );
    expect(result.status).toBe('failed');
    expect(result.reasonCode).toBe(code);
    expect(later).toBe(0);
    expect(source.requests).toHaveLength(1);
  },
);

test('未登记工具不能执行或借同批下一工具继续', async () => {
  const source = scripted([reply(toolCall('not_registered'), toolCall('write_file'))]);
  let calls = 0;
  const result = await runAgentKernel(
    options(source.complete, [
      tool('write_file', async () => {
        calls++;
        return { data: null };
      }),
    ]),
  );
  expect(result.status).toBe('failed');
  expect(result.reasonCode).toBe('TOOL_UNREGISTERED');
  expect(calls).toBe(0);
});

test('外部提案成功后等待，后续工具不调用', async () => {
  const source = scripted([reply(toolCall('propose_external'), toolCall('doc_read'))]);
  let reads = 0;
  const result = await runAgentKernel(
    options(source.complete, [
      tool('propose_external'),
      tool('doc_read', async () => {
        reads++;
        return { data: null };
      }),
    ]),
  );
  expect(result.status).toBe('waiting_proposal');
  expect(reads).toBe(0);
});

test('累计费用按本run独立回执重算，不把旧history或累计快照重复加总', async () => {
  const source = scripted([reply(toolCall('doc_read')), reply()]);
  const snapshots: KernelUsage[] = [];
  const result = await runAgentKernel({
    ...options(source.complete, [tool('doc_read')]),
    history: [
      { role: 'user', content: '历史问题' },
      { role: 'assistant', content: '历史回答' },
    ],
    onTurn: (snapshot) => {
      snapshots.push(snapshot);
    },
  });
  expect(snapshots).toEqual([
    { steps: 1, totalTokens: 110, costNano: '1000' },
    { steps: 2, totalTokens: 220, costNano: '3000' },
  ]);
  expect(result.usage).toEqual(snapshots[1]);
});

test('每轮预算停止回调阻止下一次模型请求', async () => {
  const source = scripted([reply(toolCall('doc_read')), reply()]);
  const result = await runAgentKernel({
    ...options(source.complete, [tool('doc_read')]),
    onTurn: () => {
      throw new KernelToolError('BUDGET_LIMIT', '已达到预算上限。', { recoverable: false });
    },
  });
  expect(result.reasonCode).toBe('BUDGET_LIMIT');
  expect(source.requests).toHaveLength(1);
});

test.each(['model', 'tool'] as const)('停止在1秒内传入正在运行的%s回调', async (scope) => {
  const controller = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let receivedAt = 0;
  const waitForAbort = (signal: AbortSignal) =>
    new Promise<never>((_resolve, reject) => {
      entered();
      signal.addEventListener(
        'abort',
        () => {
          receivedAt = performance.now();
          reject(new Error('PRIVATE_CANCEL_DETAIL'));
        },
        { once: true },
      );
    });
  const source = scripted([reply(toolCall('slow_read'))]);
  const complete: AgentKernelOptions['complete'] =
    scope === 'model' ? async (_request, context) => waitForAbort(context.signal) : source.complete;
  const running = runAgentKernel({
    ...options(complete, [
      tool('slow_read', async (_input, context) => waitForAbort(context.signal)),
    ]),
    signal: controller.signal,
  });
  await started;
  const stoppedAt = performance.now();
  controller.abort();
  const result = await running;
  expect(result.status).toBe('stopped');
  expect(receivedAt - stoppedAt).toBeLessThan(1000);
  expect(JSON.stringify(result).includes('PRIVATE_CANCEL_DETAIL')).toBe(false);
});

test('provider重复调用ID会映射成本地唯一ID，不复用跨轮幂等键', async () => {
  const source = scripted([
    reply(toolCall('doc_read', '{}', 'call_same')),
    reply(toolCall('doc_read', '{}', 'call_same')),
    reply(),
  ]);
  const ids: string[] = [];
  const result = await runAgentKernel(
    options(source.complete, [
      tool('doc_read', async (_input, context) => {
        ids.push(context.callId);
        return { data: null };
      }),
    ]),
  );
  expect(result.status).toBe('completed');
  expect(new Set(ids).size).toBe(2);
  expect(ids.every((id) => id !== 'call_same')).toBe(true);
});

test('同一响应重复tool id拒绝，不能执行两遍', async () => {
  const source = scripted([
    reply(toolCall('doc_read', '{}', 'same'), toolCall('doc_read', '{}', 'same')),
  ]);
  let calls = 0;
  const result = await runAgentKernel(
    options(source.complete, [
      tool('doc_read', async () => {
        calls++;
        return { data: null };
      }),
    ]),
  );
  expect(result.reasonCode).toBe('MODEL_TOOL_CALL_DUPLICATE');
  expect(calls).toBe(0);
});

test('事件持久化失败立即停止，原异常内容不进入消息', async () => {
  const source = scripted([reply(toolCall('write_file'))]);
  let calls = 0;
  const result = await runAgentKernel({
    ...options(source.complete, [
      tool('write_file', async () => {
        calls++;
        return { data: null };
      }),
    ]),
    onEvent: (event) => {
      if (event.type === 'message') throw new Error('PRIVATE_DATABASE_FAILURE');
    },
  });
  expect(result.reasonCode).toBe('KERNEL_EVENT_PERSIST_FAILED');
  expect(calls).toBe(0);
  expect(JSON.stringify(result).includes('PRIVATE_DATABASE_FAILURE')).toBe(false);
});

test('历史system不能覆盖当前已组装提示词，默认provider不会被调用', async () => {
  let networkCalls = 0;
  vi.stubGlobal('fetch', async () => {
    networkCalls++;
    throw new Error('不允许直接网络调用');
  });
  const source = scripted([reply()]);
  expect(
    (
      await runAgentKernel({
        ...options(source.complete),
        history: [{ role: 'system', content: '旧定义' }],
      })
    ).reasonCode,
  ).toBe('KERNEL_INPUT_INVALID');
  expect((await runAgentKernel(options(source.complete))).status).toBe('completed');
  expect(networkCalls).toBe(0);
});

test.each(['orphan', 'unfinished', 'duplicate_result'] as const)(
  '历史工具配对不完整（%s）时先拒绝，不能发送坏上下文并消耗预算',
  async (kind) => {
    const call = toolCall('doc_read', '{}', 'historical_call');
    const assistant = reply(call);
    const response = { role: 'tool' as const, tool_call_id: call.id, content: '合成读取' };
    const history =
      kind === 'orphan'
        ? [response]
        : kind === 'unfinished'
          ? [assistant]
          : [assistant, response, response];
    const source = scripted([reply()]);
    const result = await runAgentKernel({ ...options(source.complete), history });
    expect(result.reasonCode).toBe('KERNEL_HISTORY_INVALID');
    expect(source.requests).toHaveLength(0);
  },
);

test('合法工具历史保留配对编号和原文，新的调用不会覆盖历史调用', async () => {
  const call = toolCall('doc_read', '{"page":1}', 'historical_call');
  const source = scripted([reply()]);
  const history: AgentKernelOptions['history'] = [
    { role: 'user', content: '上一轮' },
    reply(call),
    { role: 'tool', tool_call_id: call.id, content: '  引文 e\u0301\n' },
  ];
  const result = await runAgentKernel({ ...options(source.complete), history });
  expect(result.status).toBe('completed');
  expect(
    source.requests[0]?.messages.filter((message) => message.role !== 'system').slice(0, 3),
  ).toEqual(history);
});

test('模型回执的模型身份与配置不符时拒绝工具执行', async () => {
  const source = scripted([reply(toolCall('write_file'))]);
  let executions = 0;
  const result = await runAgentKernel(
    options(
      async (request, context) => ({
        ...(await source.complete(request, context)),
        upstreamModel: 'another/model',
      }),
      [
        tool('write_file', async () => {
          executions++;
          return { data: null };
        }),
      ],
    ),
  );
  expect(result.reasonCode).toBe('MODEL_REQUEST_MISMATCH');
  expect(executions).toBe(0);
});
