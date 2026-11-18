import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { type ModelGatewayConfig } from '@cert-board/shared';
import { createIntegrationContext } from '../test-support/context.js';
import { createReviewTestContext } from '../reviews/test-support.js';
import { seedDevelopmentWorkspace } from '../workspace/seed.js';
import { seedDevelopmentBudgetPolicy } from '../budget/service.js';
import { appendConversationMessage } from '../conversations/storage.js';
import { ModelGateway, type GatewayTransport } from '../modelgw/service.js';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import type { ToolDefinition } from '../tools/registry.js';
import { executeAgentRun } from './runtime.js';
import * as leaseService from '../runs/lease.js';

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

test('模型派发前重新核对角色，已撤权运行不能把缓存上下文送往网关', async () => {
  const context = await createIntegrationContext();
  close = () => context.close();
  const store = new MemoryStore();
  await seedDevelopmentWorkspace(context.pool, store, { NODE_ENV: 'test' });
  await seedDevelopmentBudgetPolicy(context.pool, 'test');
  const target = await queued(context, 'read_only');
  await context.pool
    .query(`CREATE FUNCTION revoke_before_model_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.type='model_started' THEN DELETE FROM role_binding WHERE user_id=(SELECT user_id FROM run WHERE id=NEW.run_id); END IF;
    RETURN NEW; END; $$`);
  await context.pool.query(
    'CREATE TRIGGER revoke_before_model_dispatch BEFORE INSERT ON run_event FOR EACH ROW EXECUTE FUNCTION revoke_before_model_dispatch()',
  );
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
  const done = await executeAgentRun(
    { pool: context.pool, store, gateway, models: config, definitions: [] },
    target.runId,
  );
  expect(calls).toBe(0);
  expect(done.status).toBe('failed');
  expect(done.reasonCode).toBe('BUDGET_SCOPE_FORBIDDEN');
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
  const target = await queued(context, 'execute', conversationId);
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
  mode: 'execute' | 'read_only',
  conversationId?: string,
) {
  const userId = context.userId('RA');
  const convo =
    conversationId ??
    (
      await context.pool.query<{ id: string }>(
        'INSERT INTO conversation(project_id,user_id,goal_id,title,mode) VALUES($1,$2,$3,$4,$5) RETURNING id',
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
    message: { role: 'user', content: '请完成这次合成任务，严格按工具回执汇报。' },
  });
  return { runId, conversationId: convo, userId };
}

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
      roles: ['RA'],
      modes: ['read_only', 'execute'],
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
  const target = await queued(context, 'execute');
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

test('真实内核读取后提交真实审核卡并暂停，人工浏览器请求可以批准', async () => {
  const context = await createReviewTestContext({ autoRead: false });
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
  const target = await queued(context, 'execute', convo);
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
          : call('submit_for_review', { ...context.submission, workspaceVersion: next });
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
  const auth = await context.login('RA');
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
  expect(
    (await context.pool.query('SELECT status FROM run WHERE id=$1', [target.runId])).rows[0].status,
  ).toBe('completed');
  expect(
    (await context.pool.query('SELECT COUNT(*)::int AS count FROM submission_snapshot')).rows[0]
      .count,
  ).toBe(1);
});
