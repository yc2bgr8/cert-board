import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  conversationCreateResultSchema,
  conversationWriteResultSchema,
  documentPageReadSchema,
  type ModelGatewayConfig,
} from '@cert-board/shared';
import { createIntegrationContext } from '../test-support/context.js';
import { setTestReminderClock } from '../test-support/internal-reminder-clock.js';
import { createReviewTestContext } from '../reviews/test-support.js';
import { seedDevelopmentWorkspace } from '../workspace/seed.js';
import { seedDevelopmentBudgetPolicy } from '../budget/service.js';
import { appendConversationMessage } from '../conversations/storage.js';
import * as conversationStorage from '../conversations/storage.js';
import { ModelGateway, type GatewayTransport } from '../modelgw/service.js';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import { ingestParsedDocument } from '../documents/service.js';
import type { ToolDefinition } from '../tools/registry.js';
import { executeAgentRun } from './runtime.js';
import { buildAgentTools } from './default-tools.js';
import * as leaseService from '../runs/lease.js';
import { queueInternalMessageTool } from '../tools/queue-internal-message.js';
import { agentInteractionTools } from '../tools/agent-interaction.js';
import { prepareContinuationForDispatch } from '../approvals/continuation.js';
import { buildWorkspaceTools } from '../tools/workspace-tools.js';
import { buildSandboxTools } from '../tools/code-run.js';
import type { SandboxClient } from '../sandbox/client.js';

class MemoryStore implements DocumentBlobStore {
  private values = new Map<string, Buffer>();
  async put(content: Buffer) {
    const sha256 = createHash('sha256').update(content).digest('hex');
    this.values.set(sha256, Buffer.from(content));
    return { sha256, byteSize: content.length };
  }
  async get(id: string) {
    const value = this.values.get(id);
    if (!value) throw new Error('fixture_blob_missing');
    return Buffer.from(value);
  }
}
const config: ModelGatewayConfig = {
  version: 1,
  models: [
    {
      id: 'scripted',
      upstreamModel: 'scripted/runtime',
      baseUrl: 'https://fixture.invalid/api/v1',
      apiKeyEnv: 'FIXTURE_KEY',
      family: 'fixture',
      enabled: true,
      accepted: false,
      purposes: ['agent'],
      maxDataLevel: 'internal',
      contextLength: 1000000,
      maxOutputTokens: 1024,
      supportsImages: false,
      prices: { inputUsdPerMillion: '0', cacheReadUsdPerMillion: '0', outputUsdPerMillion: '0' },
      provider: { only: ['fixture'], allow_fallbacks: false, require_parameters: true },
      reasoning: { enabled: false },
    },
  ],
};
const result = (message: unknown, finish_reason = 'stop') => ({
  id: randomUUID(),
  object: 'chat.completion',
  choices: [{ index: 0, message, finish_reason }],
  usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: 0 },
});
const call = (name: string, input: unknown) =>
  result(
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'provider_reused_id',
          type: 'function',
          function: { name, arguments: JSON.stringify(input) },
        },
      ],
    },
    'tool_calls',
  );
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await close?.();
  close = undefined;
});

test('Agent 剧本在容器模式收不到核实工具，宿主模式仍能使用', async () => {
  const context = await createIntegrationContext();
  close = () => context.close();
  const store = new MemoryStore();
  await seedDevelopmentWorkspace(context.pool, store, { NODE_ENV: 'test' });
  await seedDevelopmentBudgetPolicy(context.pool, 'test');
  for (const containerRuntime of ['host', 'docker'] as const) {
    const target = await queued(context, 'read_only');
    const offered = vi.fn();
    const gateway = new ModelGateway(
      context.pool,
      config,
      {
        kind: 'fixture',
        async send(_model, request) {
          offered(request.tools?.map((tool) => tool.function.name) ?? []);
          return result({ role: 'assistant', content: '核对工具目录完成。' });
        },
      },
      { environment: 'test' },
    );
    const outcome = await executeAgentRun(
      {
        pool: context.pool,
        store,
        gateway,
        models: config,
        definitions: (code) => buildAgentTools(store, code, context.pool, containerRuntime),
      },
      target.runId,
    );
    expect(outcome.status).toBe('completed');
    expect(offered).toHaveBeenCalledTimes(1);
    expect(offered.mock.calls[0]?.[0]).toContain('doc_search');
    expect(offered.mock.calls[0]?.[0].includes('consult_external_model')).toBe(
      containerRuntime === 'host',
    );
  }
});

test.each(['ok', 'timed_out'] as const)('沙箱执行 %s 时只记录哈希与耗时', async (status) => {
  const context = await createIntegrationContext();
  close = () => context.close();
  const store = new MemoryStore();
  await seedDevelopmentWorkspace(context.pool, store, { NODE_ENV: 'test' });
  await seedDevelopmentBudgetPolicy(context.pool, 'test');
  const saving = status === 'timed_out';
  const target = await queued(context, saving ? 'ask' : 'read_only');
  const code = 'print("合成程序正文")';
  const codeSha256 = createHash('sha256').update(code).digest('hex');
  const artifact = Buffer.from('合成产出正文');
  const outputSha256 = createHash('sha256').update(artifact).digest('hex');
  const output = {
    status,
    exitCode: saving ? -9 : 0,
    elapsedMs: 17,
    codeSha256,
    stdout: '合成输出正文',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    files: saving
      ? []
      : [
          {
            path: '合成产出.txt',
            byteSize: artifact.length,
            sha256: outputSha256,
            bytes: artifact,
          },
        ],
  };
  let inputHashes: string[] = [];
  const run: SandboxClient['run'] = async ({ files }) => {
    const lease = await context.pool.query<{ sufficient: boolean }>(
      `SELECT lease_expires_at > clock_timestamp() + INTERVAL '155 seconds' AS sufficient FROM run WHERE id=$1`,
      [target.runId],
    );
    expect(lease.rows[0]?.sufficient).toBe(true);
    const received = files.map(({ name, bytes }) => ({
      name,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }));
    inputHashes = received.map(({ sha256 }) => sha256);
    return { ...output, inputHashes: received };
  };
  let round = 0;
  const gateway = new ModelGateway(
    context.pool,
    config,
    {
      kind: 'fixture',
      async send() {
        return round++ === 0
          ? call(saving ? 'code_run_save' : 'code_run', {
              code,
              inputs: [{ source: 'workspace', path: 'AGENTS.md', name: '示例.md' }],
              ...(saving ? { expectedDraftVersion: 1, outputDirectory: '交付/合成' } : {}),
            })
          : result({ role: 'assistant', content: '已完成计算。' });
      },
    },
    { environment: 'test' },
  );
  const outcome = await executeAgentRun(
    {
      pool: context.pool,
      store,
      gateway,
      models: config,
      definitions: buildSandboxTools(store, { run }),
    },
    target.runId,
  );
  if (saving) {
    expect(outcome).toMatchObject({ status: 'stopped', reasonCode: 'REVIEW_NOT_SUBMITTED' });
  } else {
    expect(outcome.status).toBe('completed');
  }
  const events = await context.pool.query(
    'SELECT * FROM run_event WHERE run_id=$1 AND sandbox_input_hashes IS NOT NULL',
    [target.runId],
  );
  expect(events.rows).toHaveLength(1);
  expect(inputHashes).toHaveLength(1);
  expect(events.rows[0]).toMatchObject({
    content_hash: codeSha256,
    sandbox_input_hashes: inputHashes,
    sandbox_output_hashes: saving ? [] : [outputSha256],
    duration_ms: '17',
  });
  expect(JSON.stringify(events.rows)).not.toMatch(/合成|示例/);
  if (saving) {
    const undo = await context.pool.query('SELECT id FROM undo_record WHERE run_id=$1', [
      target.runId,
    ]);
    expect(undo.rowCount).toBe(0);
  }
});

test('子任务并行共享父运行的账本，证据冲突时拦截同行写入并提问', async () => {
  const context = await createIntegrationContext();
  close = () => context.close();
  const store = new MemoryStore();
  await seedDevelopmentWorkspace(context.pool, store, { NODE_ENV: 'test' });
  await seedDevelopmentBudgetPolicy(context.pool, 'test');
  const target = await queued(context, 'ask');
  const models: ModelGatewayConfig = {
    ...config,
    models: [
      config.models[0]!,
      {
        ...config.models[0]!,
        id: 'scripted-child',
        upstreamModel: 'scripted/child',
        purposes: ['subagent'],
      },
    ],
  };
  const work = [
    { key: 'summary', title: '核对摘要', assignment: '从合成摘要核对编号' },
    { key: 'table', title: '核对表格', assignment: '从合成表格核对编号' },
    {
      key: 'unauthorized',
      title: '测试写入权限',
      assignment: '尝试以子任务身份调用未授权的催办工具',
    },
  ];
  const observed: string[] = [];
  const gateway = new ModelGateway(
    context.pool,
    models,
    {
      kind: 'fixture',
      async send(model, request) {
        const tool = (name: string, args: unknown) => ({
          id: `fixture_${name}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        });
        if (model.id === 'scripted') {
          return result(
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                tool('subagent_run', { tasks: work }),
                tool('ws_write', {
                  path: '交付/分歧前不得写入.md',
                  content: 'fixture',
                  expectedSha256: null,
                }),
              ],
            },
            'tool_calls',
          );
        }
        const prompt = request.messages.at(-1);
        if (prompt?.role !== 'user') throw new Error('fixture expected task prompt');
        const selected = z.object({ key: z.string() }).parse(JSON.parse(prompt.content));
        observed.push(selected.key);
        expect(
          request.tools?.some(
            ({ function: fn }) => fn.name === 'ws_write' || fn.name === 'reminder_set',
          ),
        ).toBe(false);
        await vi.waitFor(() => expect(observed).toHaveLength(3), { timeout: 4_000 });
        if (selected.key === 'unauthorized') return call('reminder_set', {});
        return result({
          role: 'assistant',
          content: JSON.stringify({
            summary: '合成核对',
            missing: ['原件待确认'],
            drafts: [],
            claims: [
              {
                id: selected.key,
                object: '合成器械',
                field: '编号',
                value: selected.key === 'summary' ? 'CB-42' : 'CB-24',
                unit: null,
                status: 'unverified',
                sources: [],
              },
            ],
          }),
        });
      },
    },
    { environment: 'test' },
  );
  const outcome = await executeAgentRun(
    {
      pool: context.pool,
      store,
      gateway,
      models,
      definitions: (code) => buildAgentTools(store, code, context.pool),
    },
    target.runId,
  );
  expect(outcome).toMatchObject({
    status: 'waiting',
    questionId: expect.any(String),
    usage: { steps: 4, totalTokens: 80 },
  });
  const invocations = await context.pool.query(
    'SELECT tool_name FROM tool_invocation WHERE run_id=$1',
    [target.runId],
  );
  expect(invocations.rows.map(({ tool_name }) => tool_name)).toEqual(
    expect.arrayContaining(['subagent_run', 'ask_user']),
  );
  expect(invocations.rows).not.toContainEqual({ tool_name: 'ws_write' });
  expect(invocations.rows).not.toContainEqual({ tool_name: 'reminder_set' });
  const events = await context.pool.query(
    `SELECT payload_json FROM conversation_event WHERE run_id=$1 AND type='question'`,
    [target.runId],
  );
  expect(events.rows[0]?.payload_json.question).toMatch(/CB-42.*CB-24/s);
  const usage = await context.pool.query(
    'SELECT purpose,count(*)::int AS count FROM usage_ledger WHERE run_id=$1 GROUP BY purpose ORDER BY purpose',
    [target.runId],
  );
  expect(usage.rows).toEqual([
    { purpose: 'agent', count: 1 },
    { purpose: 'subagent', count: 3 },
  ]);
});

test.each(['多轮', '单轮超长', '空摘要'] as const)(
  '长对话经模型网关压缩并保留原始消息（%s）',
  async (scenario) => {
    const context = await createIntegrationContext();
    close = () => context.close();
    const store = new MemoryStore();
    await seedDevelopmentWorkspace(context.pool, store, { NODE_ENV: 'test' });
    await seedDevelopmentBudgetPolicy(context.pool, 'test');
    const tail = '尾部确认标记 PR23';
    const original =
      scenario === '多轮'
        ? '合成历史起点。'
        : `${'段'.repeat(scenario === '空摘要' ? 52_000 : 70_000)}\n${tail}`;
    const origin = await queued(context, 'read_only', undefined, original);
    for (let index = 0; scenario === '多轮' && index < 10; index++) {
      await appendConversationMessage(context.pool, {
        runId: origin.runId,
        userId: origin.userId,
        requestKey: randomUUID(),
        message: { role: 'user', content: `合成旧记录 ${index}\n${'段'.repeat(7600)}` },
      });
    }
    await context.pool.query("UPDATE run SET status='completed' WHERE id=$1", [origin.runId]);
    const target = await queued(
      context,
      'read_only',
      origin.conversationId,
      '请引用项目说明中对写法不一致的决定。',
    );
    const models: ModelGatewayConfig = {
      ...config,
      models: [
        config.models[0]!,
        {
          ...config.models[0]!,
          id: 'scripted-summary',
          upstreamModel: 'scripted/summary',
          purposes: ['compression'],
        },
      ],
    };
    let summarized = 0;
    let sawTail = false;
    const decision = '写法不一致只能列为待确认差异';
    const gateway = new ModelGateway(
      context.pool,
      models,
      {
        kind: 'fixture',
        async send(model, request) {
          if (model.id === 'scripted-summary') {
            summarized++;
            expect(request.tools).toBeUndefined();
            expect(request.messages[0]?.content).toContain('历史资料');
            sawTail ||= request.messages[1]?.content?.includes(tail) === true;
            return result({
              role: 'assistant',
              content:
                scenario === '空摘要'
                  ? ' '
                  : `合成压缩摘要，旧资料仍在原对话。${sawTail ? tail : ''}`,
            });
          }
          expect(request.messages[0]?.content).toContain(decision);
          if (scenario === '空摘要') expect(request.messages[1]?.content).toBe(original);
          else expect(request.messages[1]?.content).toContain('合成压缩摘要');
          if (scenario === '单轮超长') expect(request.messages[1]?.content).toContain(tail);
          expect(request.messages.at(-1)?.content).toBe('请引用项目说明中对写法不一致的决定。');
          return result({ role: 'assistant', content: `项目决定：${decision}。` });
        },
      },
      { environment: 'test' },
    );
    const outcome = await executeAgentRun(
      { pool: context.pool, store, gateway, models, definitions: [] },
      target.runId,
    );
    expect(outcome.status).toBe('completed');
    expect(summarized).toBeGreaterThan(0);
    const originals = await context.pool.query(
      'SELECT count(*)::int AS count FROM conversation_message WHERE run_id=$1',
      [origin.runId],
    );
    expect(originals.rows[0]?.count).toBe(scenario === '多轮' ? 11 : 1);
    const usage = await context.pool.query(
      "SELECT count(*)::int AS count FROM usage_ledger WHERE run_id=$1 AND purpose='compression'",
      [target.runId],
    );
    expect(usage.rows[0]?.count).toBe(summarized);
  },
);

test.each([false, true])('版本重查必须解决原字段冲突，是否省略字段为 %s', async (omitField) => {
  const context = await createIntegrationContext();
  close = () => context.close();
  const store = new MemoryStore();
  await seedDevelopmentWorkspace(context.pool, store, { NODE_ENV: 'test' });
  await seedDevelopmentBudgetPolicy(context.pool, 'test');
  let documentId = '';
  for (const version of [1, 2]) {
    const imported = await ingestParsedDocument(context.pool, store, {
      projectId: context.projectId,
      sourceKey: 'SUB-FIXTURE',
      name: '合成版本.pdf',
      sourcePath: '合成版本.pdf',
      sourceSnapshot: createHash('sha256').update(`subagent-fixture-${version}`).digest('hex'),
      originalSha256: createHash('sha256').update(String(version)).digest('hex'),
      dataLevel: 'internal',
      authorType: 'external',
      sourceMetadata: {},
      pages: [
        {
          pageNumber: 1,
          text: `CB-FIXTURE-${version}`,
          method: 'text',
          locatorKind: 'physical_page',
        },
      ],
    });
    documentId = imported.documentId;
  }
  const target = await queued(context, 'read_only');
  const models: ModelGatewayConfig = {
    ...config,
    models: [
      config.models[0]!,
      {
        ...config.models[0]!,
        id: 'scripted-version-child',
        upstreamModel: 'scripted/version-child',
        purposes: ['subagent'],
      },
    ],
  };
  const seen: number[] = [];
  const gateway = new ModelGateway(
    context.pool,
    models,
    {
      kind: 'fixture',
      async send(model, request) {
        const last = request.messages.at(-1);
        if (model.id === 'scripted') {
          if (last?.role !== 'tool')
            return call('subagent_run', {
              tasks: [
                { key: 'left', title: '定位一', assignment: '核对编号' },
                { key: 'right', title: '定位二', assignment: '核对编号' },
              ],
            });
          expect(JSON.parse(last.content)).toMatchObject({ status: 'completed', conflicts: [] });
          return result({ role: 'assistant', content: '已按最新版重新核对。' });
        }
        const user = request.messages[1];
        if (user?.role !== 'user') throw new Error('missing task');
        const task = z
          .object({ key: z.string(), assignment: z.string() })
          .parse(JSON.parse(user.content));
        const isReread = task.assignment.includes('最新可读版');
        if (last?.role !== 'tool')
          return call('doc_read', {
            id: documentId,
            version: isReread || task.key === 'right' ? 2 : 1,
            page: 1,
          });
        const read = documentPageReadSchema.parse(JSON.parse(last.content));
        seen.push(read.version);
        return result({
          role: 'assistant',
          content: JSON.stringify({
            summary: '按原文核对',
            missing: [],
            drafts: [],
            claims: [
              {
                id: task.key,
                object: '合成器械',
                field: isReread && omitField ? '其他字段' : '编号',
                value: read.text,
                unit: null,
                status: 'checked',
                sources: [{ documentId, version: read.version, page: read.page, quote: read.text }],
              },
            ],
          }),
        });
      },
    },
    { environment: 'test' },
  );
  const outcome = await executeAgentRun(
    {
      pool: context.pool,
      store,
      gateway,
      models,
      definitions: (code) => buildAgentTools(store, code, context.pool),
    },
    target.runId,
  );
  expect(outcome.status).toBe(omitField ? 'waiting' : 'completed');
  if (omitField) expect(outcome.questionId).toEqual(expect.any(String));
  expect(seen.sort()).toEqual([1, 2, 2, 2]);
});

test('收尾时租约已到期的旧执行者不能写入完成状态或发出终态事件', async () => {
  const context = await createIntegrationContext();
  close = () => context.close();
  const store = new MemoryStore();
  await seedDevelopmentWorkspace(context.pool, store, { NODE_ENV: 'test' });
  await seedDevelopmentBudgetPolicy(context.pool, 'test');
  const target = await queued(context, 'read_only');
  const gateway = new ModelGateway(
    context.pool,
    config,
    {
      kind: 'fixture',
      async send() {
        await context.pool.query(
          "UPDATE run SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
          [target.runId],
        );
        return result({ role: 'assistant', content: '已返回合成结果。' });
      },
    },
    { environment: 'test' },
  );
  const done = await executeAgentRun(
    { pool: context.pool, store, gateway, models: config, definitions: [] },
    target.runId,
  );
  expect(done.status).toBe('running');
  expect(done.reasonCode).toBe('RUN_LEASE_LOST');
  const terminalEvents = await context.pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM conversation_event WHERE run_id=$1 AND type='run_status' AND payload_json ->> 'status' IN ('completed','failed','stopped','waiting')",
    [target.runId],
  );
  expect(terminalEvents.rows[0]!.count).toBe(0);
});

test('模型派发前重新核对成员状态，已撤权运行不能把缓存上下文送往网关', async () => {
  const context = await createIntegrationContext();
  close = () => context.close();
  const store = new MemoryStore();
  await seedDevelopmentWorkspace(context.pool, store, { NODE_ENV: 'test' });
  await seedDevelopmentBudgetPolicy(context.pool, 'test');
  const target = await queued(context, 'read_only');
  let calls = 0;
  const gateway = new ModelGateway(
    context.pool,
    config,
    {
      kind: 'fixture',
      async send() {
        calls++;
        return result({ role: 'assistant', content: '不应调用到此响应。' });
      },
    },
    { environment: 'test' },
  );
  const originalComplete = gateway.complete.bind(gateway);
  let gatewayRejection: string | undefined;
  vi.spyOn(gateway, 'complete').mockImplementation(async (...args) => {
    await context.pool.query(
      "UPDATE app_user SET status='disabled',version=version+1 WHERE id=$1",
      [target.userId],
    );
    try {
      return await originalComplete(...args);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error)
        gatewayRejection = String(error.code);
      throw error;
    }
  });
  const done = await executeAgentRun(
    { pool: context.pool, store, gateway, models: config, definitions: [] },
    target.runId,
  );
  expect(calls).toBe(0);
  expect(done.status).toBe('failed');
  expect(gatewayRejection).toBe('MODEL_RUN_INACTIVE');
  // 账号停用后，内核的错误消息也不能再追加为该用户的会话内容。
  expect(done.reasonCode).toBe('KERNEL_EVENT_PERSIST_FAILED');
  expect(
    (await context.pool.query('SELECT status FROM app_user WHERE id=$1', [target.userId])).rows[0]
      .status,
  ).toBe('disabled');
  expect(
    Number(
      (
        await context.pool.query('SELECT count(*) FROM usage_ledger WHERE run_id=$1', [
          target.runId,
        ])
      ).rows[0].count,
    ),
  ).toBe(0);
});

test('模型预占后最后路由等待期间被新代次接管，旧执行者零发送且释放零费用预占', async () => {
  const context = await createIntegrationContext();
  close = () => context.close();
  const store = new MemoryStore();
  await seedDevelopmentWorkspace(context.pool, store, { NODE_ENV: 'test' });
  await seedDevelopmentBudgetPolicy(context.pool, 'test');
  const target = await queued(context, 'read_only');
  const priced: ModelGatewayConfig = {
    ...config,
    models: config.models.map((model) => ({
      ...model,
      prices: { inputUsdPerMillion: '10', cacheReadUsdPerMillion: '5', outputUsdPerMillion: '20' },
    })),
  };
  let calls = 0,
    routes = 0,
    paused = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalQuery = context.pool.query;
  context.pool.query = (async (...args: unknown[]) => {
    const value: unknown = await Reflect.apply(originalQuery, context.pool, args);
    if (
      typeof args[0] === 'string' &&
      args[0].includes('AS data_level') &&
      Array.isArray(args[1]) &&
      args[1][0] === target.runId &&
      ++routes === 2
    ) {
      paused = true;
      await gate;
    }
    return value;
  }) as typeof context.pool.query;
  const gateway = new ModelGateway(
    context.pool,
    priced,
    {
      kind: 'fixture',
      async send() {
        calls++;
        return result({ role: 'assistant', content: '旧代次不能派发此请求。' });
      },
    },
    { environment: 'test' },
  );
  const running = executeAgentRun(
    { pool: context.pool, store, gateway, models: priced, definitions: [] },
    target.runId,
  );
  try {
    await vi.waitFor(() => expect(paused).toBe(true), { timeout: 3000 });
    await context.pool.query(
      "UPDATE run SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
      [target.runId],
    );
    const replacement = await leaseService.claimRunLease(context.pool, {
      runId: target.runId,
      userId: target.userId,
      ownerId: randomUUID(),
    });
    expect(replacement.generation).toBe(2);
    release();
    const done = await running;
    expect(calls).toBe(0);
    expect(done.reasonCode).toBe('RUN_LEASE_LOST');
    const ledger = (
      await context.pool.query<{ status: string; reserved_nano: string; actual_nano: string }>(
        'SELECT status,reserved_nano,actual_nano FROM usage_ledger WHERE run_id=$1',
        [target.runId],
      )
    ).rows;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.status).toBe('settled');
    expect(BigInt(ledger[0]!.reserved_nano) > 0n).toBe(true);
    expect(ledger[0]!.actual_nano).toBe('0');
    expect(
      (await context.pool.query("SELECT blocked_reason FROM budget_policy WHERE id='default'"))
        .rows[0].blocked_reason,
    ).toBeNull();
    const current = (
      await context.pool.query<{ lease_owner: string; lease_generation: string }>(
        'SELECT lease_owner,lease_generation FROM run WHERE id=$1',
        [target.runId],
      )
    ).rows[0]!;
    expect(current.lease_owner).toBe(replacement.ownerId);
    expect(Number(current.lease_generation)).toBe(replacement.generation);
  } finally {
    release();
    await running.catch(() => undefined);
    context.pool.query = originalQuery;
  }
});

test('审核卡提交已持久化但执行事件失败，仍保留reviewId并等待人工决定', async () => {
  const context = await createReviewTestContext({ autoRead: false });
  close = () => context.close();
  const store = new MemoryStore();
  await seedDevelopmentBudgetPolicy(context.pool, 'test');
  const note = await store.put(Buffer.from('# 项目说明\n合成审核生命周期验证。'));
  const next = (
    await context.pool.query<{ id: string }>(
      "INSERT INTO workspace_version(workspace_id,project_id,number,parent_version_id,author_type,summary,data_level) VALUES($1,$2,2,$3,'system','生命周期fixture','internal') RETURNING id",
      [context.workspaceId, context.projectId, context.workspaceVersion],
    )
  ).rows[0]!.id;
  await context.pool.query(
    "INSERT INTO workspace_file(version_id,path,sha256,byte_size,data_level,media_type) VALUES($1,'AGENTS.md',$2,$3,'internal','text/markdown')",
    [next, note.sha256, note.byteSize],
  );
  await context.pool.query(
    'UPDATE workspace SET current_version_id=$1,version=version+1 WHERE id=$2',
    [next, context.workspaceId],
  );
  await context.pool.query("UPDATE run SET status='completed' WHERE id=$1", [context.caller.runId]);
  const conversationId = (
    await context.pool.query<{ conversation_id: string }>(
      'SELECT conversation_id FROM run WHERE id=$1',
      [context.caller.runId],
    )
  ).rows[0]!.conversation_id;
  const target = await queued(context, 'ask', conversationId);
  await context.pool
    .query(`CREATE FUNCTION fail_review_completion_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.type='tool_completed' AND EXISTS(SELECT 1 FROM tool_invocation WHERE id=NEW.invocation_id AND tool_name='submit_for_review') THEN
      RAISE EXCEPTION 'PRIVATE_COMPLETION_EVENT_FAILURE'; END IF; RETURN NEW; END; $$`);
  await context.pool.query(
    'CREATE TRIGGER fail_review_completion_event BEFORE INSERT ON run_event FOR EACH ROW EXECUTE FUNCTION fail_review_completion_event()',
  );
  let calls = 0;
  const gateway = new ModelGateway(
    context.pool,
    config,
    {
      kind: 'fixture',
      async send() {
        calls++;
        return calls === 1
          ? call('doc_read', { id: context.documentId, version: 1, page: 1 })
          : call('submit_for_review', { ...context.submission, workspaceVersion: next });
      },
    },
    { environment: 'test' },
  );
  const done = await executeAgentRun(
    { pool: context.pool, store, gateway, models: config, definitions: context.definitions },
    target.runId,
  );
  const cards = await context.pool.query<{ id: string; status: string }>(
    'SELECT id,status FROM review_card WHERE run_id=$1',
    [target.runId],
  );
  expect(cards.rows).toHaveLength(1);
  expect(done.reviewId).toBe(cards.rows[0]!.id);
  expect(done.status).toBe('waiting');
  expect(cards.rows[0]!.status).toBe('pending');
  expect(calls).toBe(2);
});

test('退出运行必须等待已经开始的续租完成，不留下后台续租promise', async () => {
  const context = await createIntegrationContext();
  close = () => context.close();
  const store = new MemoryStore();
  await seedDevelopmentWorkspace(context.pool, store, { NODE_ENV: 'test' });
  await seedDevelopmentBudgetPolicy(context.pool, 'test');
  const target = await queued(context, 'read_only');
  let modelStarted!: () => void,
    releaseModel!: () => void,
    heartbeatStarted!: () => void,
    releaseHeartbeat!: () => void;
  const modelEntered = new Promise<void>((resolve) => {
    modelStarted = resolve;
  });
  const modelGate = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  const heartbeatEntered = new Promise<void>((resolve) => {
    heartbeatStarted = resolve;
  });
  const heartbeatGate = new Promise<void>((resolve) => {
    releaseHeartbeat = resolve;
  });
  const renew = leaseService.renewRunLease;
  let heartbeatFinished = false,
    runFinished = false;
  vi.spyOn(leaseService, 'renewRunLease').mockImplementation(async (...args) => {
    heartbeatStarted();
    await heartbeatGate;
    try {
      return await renew(...args);
    } finally {
      heartbeatFinished = true;
    }
  });
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const gateway = new ModelGateway(
    context.pool,
    config,
    {
      kind: 'fixture',
      async send() {
        modelStarted();
        await modelGate;
        return result({ role: 'assistant', content: '已完成合成只读任务。' });
      },
    },
    { environment: 'test' },
  );
  const running = executeAgentRun(
    { pool: context.pool, store, gateway, models: config, definitions: [] },
    target.runId,
  ).then((done) => {
    runFinished = true;
    return done;
  });
  try {
    await modelEntered;
    await vi.advanceTimersByTimeAsync(15000);
    await heartbeatEntered;
    releaseModel();
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    expect(runFinished).toBe(false);
    releaseHeartbeat();
    const done = await running;
    expect(heartbeatFinished).toBe(true);
    expect(done.status).toBe('completed');
  } finally {
    releaseModel();
    releaseHeartbeat();
    await running.catch(() => undefined);
  }
});
async function queued(
  context: Awaited<ReturnType<typeof createIntegrationContext>>,
  mode: 'ask' | 'read_only',
  conversationId?: string,
  text = '请完成这次合成任务，严格按工具回执汇报。',
) {
  const userId = context.userId('MEMBER_A');
  const convo =
    conversationId ??
    (
      await context.pool.query<{ id: string }>(
        'INSERT INTO conversation(project_id,user_id,goal_id,title,permission_mode) VALUES($1,$2,$3,$4,$5) RETURNING id',
        [context.projectId, userId, context.goalId, '同一内核合成验证', mode],
      )
    ).rows[0]!.id;
  const runId = (
    await context.pool.query<{ id: string }>(
      "INSERT INTO run(conversation_id,user_id,project_id,goal_id,status,trigger_type) VALUES($1,$2,$3,$4,'queued','evaluation') RETURNING id",
      [convo, userId, context.projectId, context.goalId],
    )
  ).rows[0]!.id;
  await appendConversationMessage(context.pool, {
    runId,
    userId,
    requestKey: randomUUID(),
    message: { role: 'user', content: text },
  });
  return { runId, conversationId: convo, userId };
}

test.each([
  { label: '升为请求批准', initial: 'read_only', next: 'ask', canWrite: true },
  { label: '降为只读', initial: 'ask', next: 'read_only', canWrite: false },
] as const)('浏览器运行中$label，动态授权和插话投递一致', async ({ initial, next, canWrite }) => {
  const context = await createIntegrationContext();
  close = () => context.close();
  const store = new MemoryStore();
  await seedDevelopmentWorkspace(context.pool, store, { NODE_ENV: 'test' });
  await seedDevelopmentBudgetPolicy(context.pool, 'test');
  const owner = await context.login('MEMBER_A');
  const created = await context.app.inject({
    method: 'POST',
    url: `/api/projects/${context.projectId}/conversations`,
    headers: owner.headers,
    payload: { requestKey: randomUUID(), title: '浏览器插话与模式', permissionMode: initial },
  });
  expect(created.statusCode).toBeLessThan(300);
  const thread = conversationCreateResultSchema.parse(created.json());
  const path = `/api/conversations/${thread.conversation.id}`;
  const first = await context.app.inject({
    method: 'POST',
    url: `${path}/messages`,
    headers: owner.headers,
    payload: { requestKey: randomUUID(), text: '只读核查合成项目。' },
  });
  expect(first.statusCode).toBeLessThan(300);
  const queued = conversationWriteResultSchema.parse(first.json());
  let releaseModel!: () => void;
  const paused = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  let modelStarted!: () => void;
  const entered = new Promise<void>((resolve) => {
    modelStarted = resolve;
  });
  let calls = 0;
  const model = new ModelGateway(
    context.pool,
    config,
    {
      kind: 'fixture',
      async send(_model, request) {
        calls++;
        const names = request.tools?.map((entry) => entry.function.name);
        if (calls === 1) {
          expect(names).toContain('ws_read');
          expect(names?.includes('ws_write')).toBe(initial === 'ask');
          modelStarted();
          await paused;
          if (!canWrite)
            return call('ws_write', { path: '草稿/插话核查.md', content: '过期目录选择的写入。' });
          return call('ws_read', { view: 'current', path: 'AGENTS.md', limit: 640 });
        }
        if (calls === 2) {
          expect(request.messages.slice(-2).map((message) => message.role)).toEqual([
            'tool',
            'user',
          ]);
          expect(request.messages.at(-1)).toEqual({
            role: 'user',
            content: '请建立一份合成核查草稿。',
          });
          expect(names).toContain('ws_write');
          return call('ws_write', {
            path: '草稿/插话核查.md',
            content: '# 合成核查\n已按补充意见建立。',
          });
        }
        return result({ role: 'assistant', content: '草稿已建立。' });
      },
    },
    { environment: 'test' },
  );
  const running = executeAgentRun(
    {
      pool: context.pool,
      store,
      gateway: model,
      models: config,
      definitions: buildWorkspaceTools(store),
    },
    queued.runId,
  );
  try {
    await Promise.race([
      entered,
      running.then(() => {
        throw new Error('运行在模型调用前提前结束');
      }),
    ]);
    const changed = await context.app.inject({
      method: 'PATCH',
      url: `${path}/permission-mode`,
      headers: owner.headers,
      payload: {
        requestKey: randomUUID(),
        expectedVersion: thread.permissionVersion,
        permissionMode: next,
      },
    });
    expect(changed.statusCode).toBe(200);
    const inserted = { requestKey: randomUUID(), text: '请建立一份合成核查草稿。' };
    const sent = await context.app.inject({
      method: 'POST',
      url: `${path}/messages`,
      headers: owner.headers,
      payload: inserted,
    });
    expect(sent.statusCode).toBeLessThan(300);
    const buffered = conversationWriteResultSchema.parse(sent.json());
    expect(buffered).toMatchObject({ kind: 'steering', runId: queued.runId, replayed: false });
    const retry = await context.app.inject({
      method: 'POST',
      url: `${path}/messages`,
      headers: owner.headers,
      payload: inserted,
    });
    expect(retry.json()).toMatchObject({ steeringId: buffered.steeringId, replayed: true });
    const consumed = await context.pool.query(
      'SELECT delivered_message_id FROM run_steering_message WHERE id=$1',
      [buffered.steeringId],
    );
    expect(consumed.rows[0].delivered_message_id).toBeNull();
  } finally {
    releaseModel();
    await running.catch(() => undefined);
  }
  const ended = await running;
  expect(ended.reasonCode).toBe(canWrite ? 'REVIEW_NOT_SUBMITTED' : 'TOOL_READ_ONLY');
  expect(calls).toBe(canWrite ? 3 : 1);
  const persisted = await context.pool.query(
    `SELECT (SELECT count(*)::int FROM conversation_message
    WHERE run_id=$1 AND message_json->>'role'='user') AS users,
    (SELECT count(*)::int FROM workspace_draft_file WHERE path='草稿/插话核查.md') AS drafts`,
    [queued.runId],
  );
  expect(persisted.rows[0]).toEqual(canWrite ? { users: 2, drafts: 1 } : { users: 1, drafts: 0 });
  if (!canWrite) {
    const final = await context.pool.query(
      `SELECT payload_json->>'pendingSteeringCount' AS pending
      FROM conversation_event WHERE run_id=$1 AND type='run_status' ORDER BY seq DESC LIMIT 1`,
      [queued.runId],
    );
    expect(final.rows[0].pending).toBe('1');
  }
});

test('计划事件显示进度，提问暂停同一内核并接收对话中的后续回答', async () => {
  const context = await createIntegrationContext();
  close = () => context.close();
  const store = new MemoryStore();
  await seedDevelopmentWorkspace(context.pool, store, { NODE_ENV: 'test' });
  await seedDevelopmentBudgetPolicy(context.pool, 'test');
  const first = await queued(context, 'ask');
  let calls = 0;
  const question = { question: '补充说明里说的是哪份资料？', options: ['资料甲', '资料乙'] };
  const plan = {
    steps: [{ title: '核对资料来源', status: 'running' }],
    progress: '已阅读项目说明，下一步确认资料来源。',
  };
  const gateway = new ModelGateway(
    context.pool,
    config,
    {
      kind: 'fixture',
      async send(_model, request) {
        calls++;
        if (calls === 1) return call('plan_update', plan);
        if (calls === 2) return call('ask_user', question);
        const latest = request.messages.at(-1);
        if (latest?.role !== 'user' || latest.content !== '资料甲') throw new Error('回答未被投递');
        return result({ role: 'assistant', content: '已收到回答。下一步核对资料甲。' });
      },
    },
    { environment: 'test' },
  );
  const dependencies = {
    pool: context.pool,
    store,
    gateway,
    models: config,
    definitions: agentInteractionTools(),
  };
  const waiting = await executeAgentRun(dependencies, first.runId);
  expect(waiting.status).toBe('waiting');
  expect(waiting.questionId).toBeDefined();
  expect(calls).toBe(2);
  const events = await context.pool.query(
    'SELECT type,payload_json FROM conversation_event WHERE run_id=$1 ORDER BY seq',
    [first.runId],
  );
  expect(events.rows.filter((row) => row.type === 'plan_updated')).toMatchObject([
    { payload_json: plan },
  ]);
  expect(events.rows.filter((row) => row.type === 'question')).toMatchObject([
    { payload_json: { questionId: waiting.questionId, ...question } },
  ]);
  for (const event of events.rows.filter((row) => row.type === 'tool_completed')) {
    expect(event.payload_json).toHaveProperty('summary');
    expect(event.payload_json).not.toHaveProperty('data');
  }
  const answer = await queued(context, 'ask', first.conversationId, '资料甲');
  const resumed = await executeAgentRun(dependencies, answer.runId);
  expect(calls).toBe(3);
  expect(resumed.reasonCode).toBe('REVIEW_NOT_SUBMITTED');
  const messages = await context.pool.query(
    'SELECT message_json FROM conversation_message WHERE run_id=$1',
    [answer.runId],
  );
  expect(messages.rows).toContainEqual({
    message_json: { role: 'assistant', content: '已收到回答。下一步核对资料甲。' },
  });
});

test('同一真实Pi内核领取租约、调用登记工具、持久化连续过程并只读结束', async () => {
  const context = await createIntegrationContext();
  close = () => context.close();
  const store = new MemoryStore();
  await seedDevelopmentWorkspace(context.pool, store, { NODE_ENV: 'test' });
  await seedDevelopmentBudgetPolicy(context.pool, 'test');
  const target = await queued(context, 'read_only');
  let reads = 0,
    calls = 0;
  const tool: ToolDefinition = {
    metadata: {
      name: 'probe_read',
      version: 'fixture-v1',
      publication: 'published',
      effect: 'read',
      approvalInAsk: false,
      modes: ['read_only', 'ask'],
      outputDataLevel: 'internal',
      authorizationAction: 'project.read',
      description: {
        purpose: '读取合成值。',
        whenToUse: '用于测试。',
        avoid: '无业务写入。',
        parameters: '空对象。',
        example: {},
      },
    },
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ value: z.literal('ok') }),
    async execute() {
      reads++;
      return { data: { value: 'ok' }, dataLevel: 'internal' };
    },
  };
  const transport: GatewayTransport = {
    kind: 'fixture',
    async send(_model, body) {
      calls++;
      if (calls === 1) return call('probe_read', {});
      expect(body.messages.some((message) => message.role === 'tool')).toBe(true);
      return result({ role: 'assistant', content: '合成只读任务已完成，没有写入业务记录。' });
    },
  };
  const gateway = new ModelGateway(context.pool, config, transport, { environment: 'test' });
  const done = await executeAgentRun(
    { pool: context.pool, store, gateway, models: config, definitions: [tool] },
    target.runId,
  );
  expect(done.status).toBe('completed');
  expect(reads).toBe(1);
  expect(calls).toBe(2);
  const events = await context.pool.query<{ seq: string }>(
    'SELECT seq FROM conversation_event WHERE conversation_id=$1 ORDER BY seq',
    [target.conversationId],
  );
  expect(events.rows.map((row) => Number(row.seq))).toEqual(
    events.rows.map((_row, index) => index + 1),
  );
  const row = (
    await context.pool.query(
      'SELECT lease_owner,lease_generation,budget_steps FROM run WHERE id=$1',
      [target.runId],
    )
  ).rows[0];
  expect(row.lease_owner).toBeNull();
  expect(Number(row.lease_generation)).toBe(1);
  expect(Number(row.budget_steps)).toBe(2);
  expect(
    (
      await executeAgentRun(
        { pool: context.pool, store, gateway, models: config, definitions: [tool] },
        target.runId,
      )
    ).skipped,
  ).toBe(true);
  expect(calls).toBe(2);
});

test('模型文字声称已提交不能伪造审核成功', async () => {
  const context = await createIntegrationContext();
  close = () => context.close();
  const store = new MemoryStore();
  await seedDevelopmentWorkspace(context.pool, store, { NODE_ENV: 'test' });
  await seedDevelopmentBudgetPolicy(context.pool, 'test');
  const target = await queued(context, 'ask');
  const gateway = new ModelGateway(
    context.pool,
    config,
    {
      kind: 'fixture',
      async send() {
        return result({ role: 'assistant', content: '我已提交审核。' });
      },
    },
    { environment: 'test' },
  );
  const done = await executeAgentRun(
    { pool: context.pool, store, gateway, models: config, definitions: [] },
    target.runId,
  );
  expect(done.status).toBe('stopped');
  expect(done.reasonCode).toBe('REVIEW_NOT_SUBMITTED');
  expect(
    (await context.pool.query('SELECT COUNT(*)::int AS count FROM review_card')).rows[0].count,
  ).toBe(0);
});

test.each(['allow_once', 'reject'] as const)(
  'ask经%s的浏览器决定继续原运行，使用真实回执并保留原消息',
  async (action) => {
    const context = await createIntegrationContext();
    close = () => context.close();
    await setTestReminderClock(context.pool);
    const store = new MemoryStore();
    await seedDevelopmentWorkspace(context.pool, store, { NODE_ENV: 'test' });
    await seedDevelopmentBudgetPolicy(context.pool, 'test');
    const target = await queued(context, 'ask');
    const contactId = (
      await context.pool.query<{ id: string }>(
        "INSERT INTO contact(project_id,name,address,source,internal_user_id) VALUES($1,'王敏','local-test-colleague','可信合成身份',$2) RETURNING id",
        [context.projectId, context.userId('MEMBER_B')],
      )
    ).rows[0]!.id;
    let models = 0,
      lateReads = 0;
    const late: ToolDefinition = {
      metadata: {
        name: 'late_read',
        version: 'fixture-v1',
        publication: 'published',
        effect: 'read',
        modes: ['read_only', 'ask', 'full'],
        approvalInAsk: false,
        outputDataLevel: 'internal',
        authorizationAction: 'project.read',
        description: {
          purpose: '记录后续读取。',
          whenToUse: '本地测试。',
          avoid: '不写业务。',
          parameters: '无。',
          example: {},
        },
      },
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ ok: z.literal(true) }),
      async execute() {
        lateReads++;
        return { data: { ok: true }, dataLevel: 'internal' };
      },
    };
    const gateway = new ModelGateway(
      context.pool,
      config,
      {
        kind: 'fixture',
        async send(_model, request) {
          models++;
          if (models === 2) {
            const response = request.messages.filter((message) => message.role === 'tool').at(-2);
            expect(response?.role).toBe('tool');
            if (response?.role !== 'tool') throw new Error('原调用回执缺失');
            expect(JSON.parse(response.content)).toMatchObject(
              action === 'allow_once'
                ? { status: 'queued', sent: false }
                : { executed: false, rejected: true, reason: '请先核对联系人登记' },
            );
            return result({ role: 'assistant', content: '已收到原工具的结果。' });
          }
          return result(
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'approval-call',
                  type: 'function',
                  function: {
                    name: 'queue_internal_message',
                    arguments: JSON.stringify({
                      contactId,
                      subject: '核对资料',
                      body: '请核对合成资料，不真实发送。',
                    }),
                  },
                },
                {
                  id: 'late-call',
                  type: 'function',
                  function: { name: 'late_read', arguments: '{}' },
                },
              ],
            },
            'tool_calls',
          );
        },
      },
      { environment: 'test' },
    );
    const dependencies = {
      pool: context.pool,
      store,
      gateway,
      models: config,
      definitions: [queueInternalMessageTool(), late],
    };
    const done = await executeAgentRun(dependencies, target.runId);
    expect(done.status).toBe('waiting');
    expect(Boolean(done.approvalId)).toBe(true);
    const waitingTool = await context.pool.query(
      `SELECT payload_json FROM conversation_event WHERE run_id=$1 AND type='tool_completed'
       AND payload_json->>'name'='queue_internal_message'`,
      [target.runId],
    );
    expect(waitingTool.rows).toMatchObject([{ payload_json: { awaitingApproval: true } }]);
    expect(models).toBe(1);
    expect(lateReads).toBe(0);
    expect(
      (await context.pool.query('SELECT count(*)::int AS n FROM internal_outbound_message')).rows[0]
        .n,
    ).toBe(0);
    const auth = await context.login('MEMBER_A');
    const view = await context.app.inject({
      method: 'GET',
      url: `/api/approvals/${done.approvalId}`,
      headers: auth.headers,
    });
    expect(view.statusCode).toBe(200);
    const decision = await context.app.inject({
      method: 'POST',
      url: `/api/approvals/${done.approvalId}`,
      headers: auth.headers,
      payload: {
        action,
        ...(action === 'reject' ? { reason: '请先核对联系人登记' } : {}),
        requestKey: randomUUID(),
        expectedVersion: view.json().version,
        expectedContentHash: view.json().contentHash,
      },
    });
    expect(decision.statusCode).toBe(200);
    expect(decision.json().executed).toBe(false);
    expect(
      (await context.pool.query('SELECT status FROM run WHERE id=$1', [target.runId])).rows[0]
        .status,
    ).toBe('waiting');
    expect(
      (await context.pool.query('SELECT count(*)::int AS n FROM internal_outbound_message')).rows[0]
        .n,
    ).toBe(0);
    expect(models).toBe(1);
    const ticketId = String(decision.json().continuationId);
    const savedHistory = (
      await context.pool.query<{ id: string; message_json: unknown }>(
        'SELECT id,message_json FROM conversation_message WHERE run_id=$1 ORDER BY seq',
        [target.runId],
      )
    ).rows;
    expect((await prepareContinuationForDispatch(context.pool, ticketId))?.state).toBe('queued');
    const resumed = await executeAgentRun(dependencies, target.runId, { ticketId });
    expect(resumed).toMatchObject({
      status: 'stopped',
      reasonCode: 'REVIEW_NOT_SUBMITTED',
      usage: { steps: 2 },
    });
    expect(models).toBe(2);
    expect(lateReads).toBe(0);
    expect(
      (await context.pool.query('SELECT count(*)::int AS n FROM internal_outbound_message')).rows[0]
        .n,
    ).toBe(action === 'allow_once' ? 1 : 0);
    expect(
      (await context.pool.query('SELECT state FROM run_continuation WHERE id=$1', [ticketId]))
        .rows[0].state,
    ).toBe('completed');
    const after = (
      await context.pool.query(
        'SELECT id,message_json FROM conversation_message WHERE id=ANY($1::uuid[]) ORDER BY seq',
        [savedHistory.map((message) => message.id)],
      )
    ).rows;
    expect(after).toEqual(savedHistory);
    expect((await executeAgentRun(dependencies, target.runId, { ticketId })).skipped).toBe(true);
    expect(models).toBe(2);
  },
);

test('同一内核提交带过程判断的审核卡并暂停，其他成员可通过高风险结果', async () => {
  const context = await createReviewTestContext({ autoRead: false, risk: 'high' });
  close = () => context.close();
  const store = new MemoryStore();
  await seedDevelopmentBudgetPolicy(context.pool, 'test');
  const note = await store.put(Buffer.from('# 项目说明\n合成验证，所有结论待确认。'));
  await store.put(Buffer.alloc(0));
  const next = (
    await context.pool.query<{ id: string }>(
      "INSERT INTO workspace_version(workspace_id,project_id,number,parent_version_id,author_type,summary,data_level) VALUES($1,$2,2,$3,'system','内核fixture','internal') RETURNING id",
      [context.workspaceId, context.projectId, context.workspaceVersion],
    )
  ).rows[0]!.id;
  await context.pool.query(
    "INSERT INTO workspace_file(version_id,path,sha256,byte_size,data_level,media_type) VALUES($1,'AGENTS.md',$2,$3,'internal','text/markdown')",
    [next, note.sha256, note.byteSize],
  );
  await context.pool.query(
    'UPDATE workspace SET current_version_id=$1,version=version+1 WHERE id=$2',
    [next, context.workspaceId],
  );
  await context.pool.query(
    "UPDATE run SET status='completed',finished_at=CURRENT_TIMESTAMP WHERE id=$1",
    [context.caller.runId],
  );
  const convo = (
    await context.pool.query<{ conversation_id: string }>(
      'SELECT conversation_id FROM run WHERE id=$1',
      [context.caller.runId],
    )
  ).rows[0]!.conversation_id;
  const target = await queued(context, 'ask', convo);
  const decisions = [
    {
      id: 'D1',
      subject: '两处不同编号的处理',
      choice: '并列列出，交注册人员核对',
      alternatives: ['根据一处写法修改另一处'],
      reason: '两处引用支持写法不一致。正确编号待确认。',
      sources: context.submission.evidence,
      risk: 'high',
    },
  ];
  let count = 0;
  const gateway = new ModelGateway(
    context.pool,
    config,
    {
      kind: 'fixture',
      async send() {
        count++;
        return count === 1
          ? call('doc_read', { id: context.documentId, version: 1, page: 1 })
          : call('submit_for_review', { ...context.submission, workspaceVersion: next, decisions });
      },
    },
    { environment: 'test' },
  );
  const done = await executeAgentRun(
    { pool: context.pool, store, gateway, models: config, definitions: context.definitions },
    target.runId,
  );
  expect(done.status).toBe('waiting');
  expect(count).toBe(2);
  expect(Boolean(done.reviewId)).toBe(true);
  const card = (
    await context.pool.query('SELECT version,workspace_version_id FROM review_card WHERE id=$1', [
      done.reviewId,
    ])
  ).rows[0];
  const auth = await context.login('MEMBER_B');
  const view = await context.app.inject({
    method: 'GET',
    url: `/api/reviews/${done.reviewId}`,
    headers: auth.headers,
  });
  expect(view.statusCode).toBe(200);
  expect(view.json()).toMatchObject({ risk: 'high', submission: { decisions } });
  const approved = await context.app.inject({
    method: 'POST',
    url: `/api/reviews/${done.reviewId}/decision`,
    headers: auth.headers,
    payload: {
      expectedVersion: card.version,
      workspaceVersion: card.workspace_version_id,
      action: 'approved',
      requestKey: randomUUID(),
    },
  });
  expect(approved.statusCode).toBe(200);
  const decision = (
    await context.pool.query('SELECT actor_user_id FROM review_decision WHERE card_id=$1', [
      done.reviewId,
    ])
  ).rows[0];
  expect(decision.actor_user_id).toBe(context.userId('MEMBER_B'));
  expect(
    (await context.pool.query('SELECT status FROM run WHERE id=$1', [target.runId])).rows[0].status,
  ).toBe('completed');
  expect(
    (await context.pool.query('SELECT COUNT(*)::int AS count FROM submission_snapshot')).rows[0]
      .count,
  ).toBe(1);
});

test.each(['approved', 'rejected'] as const)(
  '运行收尾与浏览器%s并发时旧waiting不能覆盖更晚的真实决定',
  async (action) => {
    const context = await createReviewTestContext({ autoRead: false });
    close = () => context.close();
    const store = new MemoryStore();
    await seedDevelopmentBudgetPolicy(context.pool, 'test');
    const note = await store.put(Buffer.from('# 项目说明\n审核收尾竞态合成验证。'));
    const next = (
      await context.pool.query<{ id: string }>(
        "INSERT INTO workspace_version(workspace_id,project_id,number,parent_version_id,author_type,summary,data_level) VALUES($1,$2,2,$3,'system','收尾竞态fixture','internal') RETURNING id",
        [context.workspaceId, context.projectId, context.workspaceVersion],
      )
    ).rows[0]!.id;
    await context.pool.query(
      "INSERT INTO workspace_file(version_id,path,sha256,byte_size,data_level,media_type) VALUES($1,'AGENTS.md',$2,$3,'internal','text/markdown')",
      [next, note.sha256, note.byteSize],
    );
    await context.pool.query(
      'UPDATE workspace SET current_version_id=$1,version=version+1 WHERE id=$2',
      [next, context.workspaceId],
    );
    await context.pool.query("UPDATE run SET status='completed' WHERE id=$1", [
      context.caller.runId,
    ]);
    const conversationId = (
      await context.pool.query<{ conversation_id: string }>(
        'SELECT conversation_id FROM run WHERE id=$1',
        [context.caller.runId],
      )
    ).rows[0]!.conversation_id;
    const target = await queued(context, 'ask', conversationId);
    const auth = await context.login('MEMBER_B');
    let approval: Promise<{ statusCode: number }> | undefined;
    let intercepted = false;
    const originalQuery = context.pool.query;
    async function beginApproval() {
      intercepted = true;
      const card = (
        (await Reflect.apply(originalQuery, context.pool, [
          'SELECT id,version,workspace_version_id FROM review_card WHERE run_id=$1',
          [target.runId],
        ])) as { rows: { id: string; version: number; workspace_version_id: string }[] }
      ).rows[0]!;
      approval = context.app.inject({
        method: 'POST',
        url: `/api/reviews/${card.id}/decision`,
        headers: auth.headers,
        payload: {
          expectedVersion: card.version,
          workspaceVersion: card.workspace_version_id,
          requestKey: randomUUID(),
          action,
          ...(action === 'rejected' ? { reason: '请核对原件后重提。' } : {}),
        },
      });
    }
    // 旧实现的确定性窗口：独立SELECT已经取得waiting，浏览器决定先提交，再返回旧读取结果。
    context.pool.query = (async (...args: unknown[]) => {
      const value: unknown = await Reflect.apply(originalQuery, context.pool, args);
      if (
        !intercepted &&
        args[0] === 'SELECT status FROM run WHERE id=$1' &&
        Array.isArray(args[1]) &&
        args[1][0] === target.runId &&
        (value as { rows: { status: string }[] }).rows[0]?.status === 'waiting'
      ) {
        await beginApproval();
        await approval;
      }
      return value;
    }) as typeof context.pool.query;
    const append = conversationStorage.appendConversationEventTx;
    vi.spyOn(conversationStorage, 'appendConversationEventTx').mockImplementation(
      async (tx, input) => {
        const value = input as {
          runId?: string;
          event?: { type?: string; payload?: { status?: string } };
        };
        if (
          !intercepted &&
          value.runId === target.runId &&
          value.event?.type === 'run_status' &&
          value.event.payload?.status === 'waiting'
        ) {
          await beginApproval();
          // 新实现必须让真实审批在同一个goal/conversation锁后等待，而非把旧状态推到终态之后。
          await vi.waitFor(
            async () => {
              const rows = await Reflect.apply(originalQuery, context.pool, [
                "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()",
              ]);
              expect((rows as { rows: { count: number }[] }).rows[0]!.count).toBeGreaterThan(0);
            },
            { timeout: 3000, interval: 20 },
          );
        }
        return append(tx, input);
      },
    );
    let calls = 0;
    const gateway = new ModelGateway(
      context.pool,
      config,
      {
        kind: 'fixture',
        async send() {
          return ++calls === 1
            ? call('doc_read', { id: context.documentId, version: 1, page: 1 })
            : call('submit_for_review', { ...context.submission, workspaceVersion: next });
        },
      },
      { environment: 'test' },
    );
    try {
      await executeAgentRun(
        { pool: context.pool, store, gateway, models: config, definitions: context.definitions },
        target.runId,
      );
      expect(intercepted).toBe(true);
      expect((await approval)?.statusCode).toBe(200);
      const terminal = action === 'approved' ? 'completed' : 'stopped';
      expect(
        (await context.pool.query('SELECT status FROM run WHERE id=$1', [target.runId])).rows[0]
          ?.status,
      ).toBe(terminal);
      const statuses = (
        await context.pool.query<{ status: string }>(
          "SELECT payload_json->>'status' AS status FROM conversation_event WHERE run_id=$1 AND type='run_status' ORDER BY seq",
          [target.runId],
        )
      ).rows.map((row) => row.status);
      expect(statuses.at(-1)).toBe(terminal);
      const terminalIndex = statuses.indexOf(terminal);
      expect(statuses.slice(terminalIndex + 1)).not.toContain('waiting');
      expect(calls).toBe(2);
    } finally {
      context.pool.query = originalQuery;
      await approval?.catch(() => undefined);
    }
  },
);
