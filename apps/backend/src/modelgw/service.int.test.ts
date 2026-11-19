import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { GatewayContext, ModelGatewayConfig } from '@cert-board/shared';
import { createIntegrationContext } from '../test-support/context.js';
import {
  seedDevelopmentBudgetPolicy,
  getBudgetSummary,
  reconcileUsage,
} from '../budget/service.js';
import { ModelGateway, type GatewayTransport, type UpstreamChatRequest } from './service.js';

let context: Awaited<ReturnType<typeof createIntegrationContext>>;
let caller: GatewayContext;
const configuration: ModelGatewayConfig = {
  version: 1,
  models: [
    {
      id: 'fixture-model',
      upstreamModel: 'fixture/upstream',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      family: 'fixture',
      enabled: true,
      accepted: false,
      purposes: ['agent', 'evaluation'],
      maxDataLevel: 'internal',
      contextLength: 100000,
      maxOutputTokens: 256,
      supportsImages: false,
      prices: { inputUsdPerMillion: '10', cacheReadUsdPerMillion: '5', outputUsdPerMillion: '20' },
      provider: { only: ['fixture-provider'], allow_fallbacks: false, require_parameters: true },
      reasoning: { enabled: false },
    },
  ],
};
const request = {
  messages: [{ role: 'user' as const, content: '请调用读取工具。' }],
  max_tokens: 64,
  tools: [
    {
      type: 'function' as const,
      function: {
        name: 'read_example',
        description: '读取本地测试示例',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
  ],
};
function response(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fixture-completion',
    model: 'fixture/upstream',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_fixture',
              type: 'function',
              index: 0,
              function: { name: 'read_example', arguments: '{}' },
            },
          ],
        },
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_tokens_details: { cached_tokens: 20 },
      cost: '0.001',
    },
    ...overrides,
  };
}
function transport(result: unknown) {
  let calls = 0;
  let body: UpstreamChatRequest | undefined;
  const handler: GatewayTransport = {
    kind: 'fixture',
    async send(_model, requestBody) {
      calls++;
      body = requestBody;
      return result;
    },
  };
  return { handler, calls: () => calls, body: () => body };
}
beforeEach(async () => {
  context = await createIntegrationContext();
  await seedDevelopmentBudgetPolicy(context.pool, 'test');
  const run = await context.run();
  caller = {
    requestKey: randomUUID(),
    runId: run.runId,
    conversationId: run.conversationId,
    userId: run.userId,
    purpose: 'agent',
  };
});
afterEach(async () => {
  vi.unstubAllEnvs();
  if (context) await context.close();
});

test('配置模型和限价透传，工具调用保留，用量先结算且只新预占派发一次', async () => {
  const source = transport(response());
  const gateway = new ModelGateway(context.pool, configuration, source.handler, {
    environment: 'test',
  });
  const result = await gateway.complete(request, caller);
  expect(result.model).toBe('fixture-model');
  expect(result.upstreamModel).toBe('fixture/upstream');
  expect(result.message.tool_calls?.[0]?.function.name).toBe('read_example');
  expect(result.usage.costNano).toBe('1000000');
  expect(source.body()?.provider.max_price).toEqual({ prompt: 10, completion: 20 });
  expect(source.body()?.provider.allow_fallbacks).toBe(false);
  expect(source.body()?.reasoning.enabled).toBe(false);
  expect(source.body()?.model).toBe('fixture/upstream');
  expect(source.body()?.stream).toBe(false);
  await expect(gateway.complete(request, caller)).rejects.toMatchObject({
    code: 'MODEL_REQUEST_ALREADY_RESERVED',
  });
  expect(source.calls()).toBe(1);
  const budget = await getBudgetSummary(context.pool);
  expect(budget.nightCostNano).toBe('1000000');
  expect(budget.nightReservedNano).toBe('0');
  expect(budget.counts.settled).toBe(1);
  expect(
    (
      await context.pool.query('SELECT model_id FROM usage_ledger WHERE request_key=$1', [
        caller.requestKey,
      ])
    ).rows[0].model_id,
  ).toBe('fixture/upstream');
});

test('assistant结构坏但usage完整，费用仍登记且不会执行坏消息', async () => {
  const source = transport(response({ choices: [] }));
  const gateway = new ModelGateway(context.pool, configuration, source.handler, {
    environment: 'test',
  });
  await expect(gateway.complete(request, caller)).rejects.toMatchObject({
    code: 'MODEL_RESPONSE_INVALID',
  });
  const summary = await getBudgetSummary(context.pool);
  expect(summary.nightCostNano).toBe('1000000');
  expect(summary.counts.settled).toBe(1);
  expect(summary.counts.unknown).toBe(0);
  expect(source.calls()).toBe(1);
});

test('HTTP错误带数字字符串usage.cost也先结算，错误正文不回显', async () => {
  const handler: GatewayTransport = {
    kind: 'fixture',
    async send() {
      throw Object.assign(new Error('UPSTREAM_PRIVATE_ERROR_CONTENT'), {
        httpStatus: 502,
        usage: { prompt_tokens: 100, completion_tokens: 10, cost: '0.015' },
      });
    },
  };
  const gateway = new ModelGateway(context.pool, configuration, handler, { environment: 'test' });
  let error: unknown;
  try {
    await gateway.complete(request, caller);
  } catch (caught) {
    error = caught;
  }
  expect((error as Error).message.includes('UPSTREAM_PRIVATE_ERROR_CONTENT')).toBe(false);
  expect((await getBudgetSummary(context.pool)).nightCostNano).toBe('15000000');
  expect((await getBudgetSummary(context.pool)).counts.unknown).toBe(0);
});

test('缺失用量保留全额预占并冻结，不会自动再次调用', async () => {
  const source = transport(response({ usage: undefined }));
  const gateway = new ModelGateway(context.pool, configuration, source.handler, {
    environment: 'test',
  });
  await expect(gateway.complete(request, caller)).rejects.toMatchObject({
    code: 'MODEL_USAGE_INCOMPLETE',
  });
  const summary = await getBudgetSummary(context.pool);
  expect(summary.counts.unknown).toBe(1);
  expect(BigInt(summary.nightReservedNano) > 0n).toBe(true);
  expect(summary.blockedReason).toBe('metering_incomplete');
  await expect(
    gateway.complete(request, { ...caller, requestKey: randomUUID() }),
  ).rejects.toMatchObject({ code: 'MODEL_METERING_BLOCKED' });
  expect(
    (await context.pool.query('SELECT status FROM run WHERE id=$1', [caller.runId])).rows[0].status,
  ).toBe('budget_exhausted');
  expect(source.calls()).toBe(1);
});

test('无provider cost时使用完整usage和配置价格，缓存不是重复计费', async () => {
  const source = transport(
    response({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 20 },
      },
    }),
  );
  const result = await new ModelGateway(context.pool, configuration, source.handler, {
    environment: 'test',
  }).complete(request, caller);
  expect(result.usage.costNano).toBe('1100000');
  expect(result.usage.totalTokens).toBe(110);
  expect(result.usage.cacheReadTokens).toBe(20);
});

test.each(['conversation', 'run', 'workspace', 'draft', 'document'])(
  '最高级别来自%s时，旧会话也不能发远端',
  async (scope) => {
    if (scope === 'conversation')
      await context.pool.query(
        "UPDATE conversation SET max_data_level='confidential' WHERE id=$1",
        [caller.conversationId],
      );
    else if (scope === 'run')
      await context.pool.query("UPDATE run SET max_data_level='confidential' WHERE id=$1", [
        caller.runId,
      ]);
    else if (scope === 'document') {
      const doc = (
        await context.pool.query<{ id: string }>(
          "INSERT INTO document(project_id,source_key,name,source_path,owner_user_id) VALUES($1,'CONF-SOURCE','保密测试资料','source.txt',$2) RETURNING id",
          [context.projectId, caller.userId],
        )
      ).rows[0]!.id;
      await context.pool.query(
        "INSERT INTO document_version(document_id,version_no,source_snapshot,content_sha256,byte_size,media_type,content_kind,data_level,author_type) VALUES($1,1,$2,$3,0,'text/plain','parsed_text','confidential','external')",
        [doc, 'a'.repeat(64), 'b'.repeat(64)],
      );
      await context.pool.query(
        "UPDATE document SET voided=true,void_reason='已作废仍不能让历史降级' WHERE id=$1",
        [doc],
      );
    } else {
      const tx = await context.pool.connect();
      try {
        await tx.query('BEGIN');
        const workspace = (
          await tx.query<{ id: string }>(
            'INSERT INTO workspace(project_id,data_level) VALUES($1,$2) RETURNING id',
            [context.projectId, scope === 'workspace' ? 'confidential' : 'internal'],
          )
        ).rows[0]!.id;
        const version = (
          await tx.query<{ id: string }>(
            "INSERT INTO workspace_version(workspace_id,project_id,number,author_type,summary,data_level) VALUES($1,$2,1,'system','路由测试',$3) RETURNING id",
            [workspace, context.projectId, scope === 'workspace' ? 'confidential' : 'internal'],
          )
        ).rows[0]!.id;
        await tx.query('UPDATE workspace SET current_version_id=$1 WHERE id=$2', [
          version,
          workspace,
        ]);
        if (scope === 'draft')
          await tx.query(
            "INSERT INTO workspace_draft(workspace_id,project_id,conversation_id,owner_user_id,base_version_id,data_level) VALUES($1,$2,$3,$4,$5,'confidential')",
            [workspace, context.projectId, caller.conversationId, caller.userId, version],
          );
        await tx.query('COMMIT');
      } catch (error) {
        await tx.query('ROLLBACK');
        throw error;
      } finally {
        tx.release();
      }
    }
    const source = transport(response());
    const gateway = new ModelGateway(context.pool, configuration, source.handler, {
      environment: 'test',
    });
    await expect(gateway.complete(request, caller)).rejects.toMatchObject({
      code: 'MODEL_LOCAL_REQUIRED',
    });
    expect(source.calls()).toBe(0);
    expect((await getBudgetSummary(context.pool)).counts.reserved).toBe(0);
  },
);

test('运行和对话归属不能伪造，模型和用途只能从已启用配置选择', async () => {
  const source = transport(response());
  const gateway = new ModelGateway(context.pool, configuration, source.handler, {
    environment: 'test',
  });
  await expect(
    gateway.complete(request, { ...caller, userId: context.userId('MEMBER_B') }),
  ).rejects.toMatchObject({ code: 'MODEL_CONTEXT_FORBIDDEN' });
  await expect(
    gateway.complete(request, { ...caller, conversationId: randomUUID() }),
  ).rejects.toMatchObject({ code: 'MODEL_CONTEXT_FORBIDDEN' });
  await expect(
    gateway.complete({ ...request, model: 'not-configured' }, caller),
  ).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
  await expect(
    gateway.complete(request, { ...caller, purpose: 'not_enabled' }),
  ).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
  expect(source.calls()).toBe(0);
});

test('fixture在开发或生产不能伪装真实上游，未验收模型在生产拒绝', async () => {
  const source = transport(response());
  expect(
    () =>
      new ModelGateway(context.pool, configuration, source.handler, { environment: 'development' }),
  ).toThrow('剧本测试上游只能');
  expect(
    () =>
      new ModelGateway(context.pool, configuration, source.handler, { environment: 'production' }),
  ).toThrow('剧本测试上游只能');
  const real: GatewayTransport = {
    kind: 'real',
    async send() {
      throw new Error('不应调用');
    },
  };
  await expect(
    new ModelGateway(context.pool, configuration, real, { environment: 'production' }).complete(
      request,
      caller,
    ),
  ).rejects.toMatchObject({ code: 'MODEL_NOT_ACCEPTED' });
});

test('输入、输出和stream边界在付费前拒绝', async () => {
  const source = transport(response());
  const gateway = new ModelGateway(context.pool, configuration, source.handler, {
    environment: 'test',
  });
  await expect(gateway.complete({ ...request, stream: true }, caller)).rejects.toMatchObject({
    code: 'MODEL_INPUT_INVALID',
  });
  await expect(gateway.complete({ ...request, max_tokens: 257 }, caller)).rejects.toMatchObject({
    code: 'MODEL_OUTPUT_LIMIT',
  });
  await expect(
    gateway.complete({ messages: [{ role: 'user', content: '字'.repeat(100000) }] }, caller),
  ).rejects.toMatchObject({ code: 'MODEL_INPUT_LIMIT' });
  expect(source.calls()).toBe(0);
});

test('取消信号透传，已有完整费用先登记但不返回可执行输出', async () => {
  const controller = new AbortController();
  let received = false;
  const source: GatewayTransport = {
    kind: 'fixture',
    async send(_model, _body, signal) {
      received = signal === controller.signal;
      controller.abort();
      return response();
    },
  };
  const gateway = new ModelGateway(context.pool, configuration, source, { environment: 'test' });
  await expect(gateway.complete(request, caller, controller.signal)).rejects.toMatchObject({
    code: 'MODEL_ABORTED',
  });
  expect(received).toBe(true);
  expect((await getBudgetSummary(context.pool)).nightCostNano).toBe('1000000');
});

test('调用前已经取消不会预占或发出请求', async () => {
  const controller = new AbortController();
  controller.abort();
  const source = transport(response());
  await expect(
    new ModelGateway(context.pool, configuration, source.handler, { environment: 'test' }).complete(
      request,
      caller,
      controller.signal,
    ),
  ).rejects.toMatchObject({ code: 'MODEL_ABORTED' });
  expect(source.calls()).toBe(0);
  expect((await getBudgetSummary(context.pool)).counts.reserved).toBe(0);
});

test('同一网关在持久核账完成后才能派发新运行', async () => {
  let calls = 0;
  const handler: GatewayTransport = {
    kind: 'fixture',
    async send() {
      calls++;
      return calls === 1 ? response({ usage: undefined }) : response();
    },
  };
  const gateway = new ModelGateway(context.pool, configuration, handler, { environment: 'test' });
  await expect(gateway.complete(request, caller)).rejects.toMatchObject({
    code: 'MODEL_USAGE_INCOMPLETE',
  });
  const ledger = (
    await context.pool.query<{ id: string }>('SELECT id FROM usage_ledger WHERE request_key=$1', [
      caller.requestKey,
    ])
  ).rows[0]!;
  await expect(
    gateway.complete(request, { ...caller, requestKey: randomUUID() }),
  ).rejects.toMatchObject({ code: 'MODEL_METERING_BLOCKED' });
  expect(calls).toBe(1);
  await reconcileUsage(context.pool, {
    ledgerId: ledger.id,
    outcome: 'reserved_estimate',
    evidence: '隔离测试按预占核账',
  });
  const fresh = await context.run();
  await expect(
    gateway.complete(request, {
      ...caller,
      requestKey: randomUUID(),
      runId: fresh.runId,
      conversationId: fresh.conversationId,
      userId: fresh.userId,
    }),
  ).resolves.toMatchObject({ usage: { costNano: '1000000' } });
  expect(calls).toBe(2);
  expect((await getBudgetSummary(context.pool)).settledEstimatedCount).toBe(1);
});

test.each([false, true])(
  '结算存储失败时拒绝再派发，即使unknown登记也失败=%s',
  async (blockUnknown) => {
    await context.pool
      .query(`CREATE FUNCTION fail_gateway_meter() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.status='settled' ${blockUnknown ? "OR NEW.status='unknown'" : ''} THEN RAISE EXCEPTION 'SIMULATED_PRIVATE_STORAGE_FAILURE'; END IF; RETURN NEW; END; $$`);
    await context.pool.query(
      'CREATE TRIGGER fail_gateway_meter BEFORE UPDATE ON usage_ledger FOR EACH ROW EXECUTE FUNCTION fail_gateway_meter()',
    );
    const source = transport(response());
    const gateway = new ModelGateway(context.pool, configuration, source.handler, {
      environment: 'test',
    });
    let message = '';
    try {
      await gateway.complete(request, caller);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.includes('SIMULATED_PRIVATE_STORAGE_FAILURE')).toBe(false);
    await expect(
      gateway.complete(request, { ...caller, requestKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'MODEL_METERING_BLOCKED' });
    expect(source.calls()).toBe(1);
    const ledger = (
      await context.pool.query(
        'SELECT status,reserved_nano,actual_nano FROM usage_ledger WHERE request_key=$1',
        [caller.requestKey],
      )
    ).rows[0];
    expect(ledger.status).toBe(blockUnknown ? 'reserved' : 'unknown');
    expect(BigInt(ledger.reserved_nano) > 0n).toBe(true);
    expect(ledger.actual_nano).toBeNull();
  },
);

test('生产进程不能用显式test选项开启fixture', () => {
  vi.stubEnv('NODE_ENV', 'production');
  const source = transport(response());
  expect(
    () => new ModelGateway(context.pool, configuration, source.handler, { environment: 'test' }),
  ).toThrow('生产进程');
});

test('另一请求已预占并通过路由时，计量双重存储失败仍阻止其派发', async () => {
  await context.pool
    .query(`CREATE FUNCTION fail_concurrent_gateway_meter() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.status IN ('settled','unknown') THEN RAISE EXCEPTION 'SIMULATED_PRIVATE_STORAGE_FAILURE'; END IF; RETURN NEW; END; $$`);
  await context.pool.query(
    'CREATE TRIGGER fail_concurrent_gateway_meter BEFORE UPDATE ON usage_ledger FOR EACH ROW EXECUTE FUNCTION fail_concurrent_gateway_meter()',
  );
  const otherRun = await context.run();
  const secondCaller: GatewayContext = {
    ...caller,
    requestKey: randomUUID(),
    runId: otherRun.runId,
    conversationId: otherRun.conversationId,
    userId: otherRun.userId,
  };
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  let releaseRouting!: () => void;
  const routingGate = new Promise<void>((resolve) => {
    releaseRouting = resolve;
  });
  let calls = 0;
  let routingCount = 0;
  let routingPaused = false;
  const originalQuery = context.pool.query;
  context.pool.query = (async (...args: unknown[]) => {
    const result: unknown = await Reflect.apply(originalQuery, context.pool, args);
    if (
      typeof args[0] === 'string' &&
      args[0].includes('AS data_level') &&
      Array.isArray(args[1]) &&
      args[1][0] === secondCaller.runId
    ) {
      routingCount++;
      if (routingCount === 2) {
        routingPaused = true;
        await routingGate;
      }
    }
    return result;
  }) as typeof context.pool.query;
  const source: GatewayTransport = {
    kind: 'fixture',
    async send() {
      calls++;
      await responseGate;
      return response();
    },
  };
  const gateway = new ModelGateway(context.pool, configuration, source, { environment: 'test' });
  const resultCode = (promise: Promise<unknown>) =>
    promise.then(
      () => 'unexpected_success',
      (error: unknown) => (error as { code?: string }).code,
    );
  const first = resultCode(gateway.complete(request, caller));
  let second: Promise<string | undefined> | undefined;
  try {
    await vi.waitFor(() => expect(calls).toBe(1), { timeout: 3000 });
    second = resultCode(gateway.complete(request, secondCaller));
    await vi.waitFor(() => expect(routingPaused).toBe(true), { timeout: 3000 });
    releaseResponse();
    expect(await first).toBe('MODEL_METERING_FAILED');
    releaseRouting();
    expect(await second).toBe('MODEL_METERING_BLOCKED');
    expect(calls).toBe(1);
    const rows = await context.pool.query<{ status: string; actual_nano: string | null }>(
      'SELECT status,actual_nano FROM usage_ledger WHERE request_key=ANY($1::uuid[])',
      [[caller.requestKey, secondCaller.requestKey]],
    );
    expect(rows.rows).toEqual([
      { status: 'reserved', actual_nano: null },
      { status: 'reserved', actual_nano: null },
    ]);
  } finally {
    releaseResponse();
    releaseRouting();
    await Promise.all([first, second]);
    context.pool.query = originalQuery;
  }
});
