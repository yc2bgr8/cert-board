import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  externalModelArchiveSchema,
  externalModelArchivePageSchema,
  externalModelConversationSchema,
  externalModelExchangeSchema,
  externalModelSetupSchema,
  workspaceRecordSchema,
} from '@cert-board/shared';
import { createApp } from '../app.js';
import { getBudgetSummary, seedDevelopmentBudgetPolicy } from '../budget/service.js';
import { createTestBlobStore } from '../documents/test-blob-store.js';
import { createIntegrationContext } from '../test-support/context.js';
import { externalModelFixture } from '../test-support/external-model-fixture.js';
import { seedDevelopmentWorkspace } from '../workspace/seed.js';

let context: Awaited<ReturnType<typeof createIntegrationContext>>;
let app: ReturnType<typeof createApp>;
let fixture: ReturnType<typeof externalModelFixture>;
let storage: Awaited<ReturnType<typeof createTestBlobStore>> | undefined;
let headers: Awaited<ReturnType<typeof context.login>>['headers'];
const prefix = '/api/external-model';

function withFixture(limit?: bigint) {
  fixture = externalModelFixture(limit);
  return createApp(context.config, {
    database: context.pool,
    ...(storage ? { blobStore: storage.store } : {}),
    externalModelRuntime: fixture.runtime,
    checkDatabase: async () => undefined,
    checkStorage: async () => undefined,
    close: async () => undefined,
  });
}
beforeEach(async () => {
  context = await createIntegrationContext();
  app = withFixture();
  headers = (await context.login()).headers;
});
afterEach(async () => {
  await app?.close();
  await storage?.dispose();
  storage = undefined;
  await context?.close();
});
async function createConversation() {
  const response = await app.inject({
    url: `${prefix}/conversations`,
    method: 'POST',
    headers,
    payload: { title: '合成外部对话', requestKey: randomUUID() },
  });
  expect(response.statusCode).toBe(200);
  return externalModelConversationSchema.parse(response.json()).id;
}
const message = (text: string) => ({ text, model: 'external-fixture', requestKey: randomUUID() });

test('仅真实浏览器会话写入；默认本地检查未接时禁止发送', async () => {
  const setup = await context.app.inject({ url: `${prefix}/setup`, headers });
  expect(externalModelSetupSchema.parse(setup.json())).toMatchObject({
    readiness: 'pending_local_policy',
    models: [],
    budget: { limitNano: '20000000000' },
  });
  const conversationId = await createConversation();
  const url = `${prefix}/conversations/${conversationId}/messages`;
  const { 'x-csrf-token': _, ...withoutCsrf } = headers;
  expect(
    (
      await app.inject({
        url,
        method: 'POST',
        headers: withoutCsrf,
        payload: message('准备核对。'),
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await context.app.inject({ url, method: 'POST', headers, payload: message('准备核对。') }))
      .statusCode,
  ).toBe(503);
  expect((await context.pool.query('SELECT id FROM external_model_exchange')).rowCount).toBe(0);
});

test('外发全文保留替换代号，回答换回原词，历史、幂等与档案按人隔离', async () => {
  const word = await app.inject({
    url: `${prefix}/words`,
    method: 'POST',
    headers,
    payload: { phrase: '合成客户甲', category: 'customer' },
  });
  expect(word.statusCode).toBe(200);
  const conversationId = await createConversation();
  const url = `${prefix}/conversations/${conversationId}/messages`;
  const body = message('请核对合成客户甲的资料。');
  const result = await app.inject({ url, method: 'POST', headers, payload: body });
  expect(result.statusCode).toBe(200);
  const exchange = externalModelExchangeSchema.parse(result.json());
  expect(exchange).toMatchObject({ status: 'settled', replacementCount: 1, search: true });
  expect(exchange.answer).toContain('合成客户甲');
  expect(exchange.references).toHaveLength(1);
  const storedResponse = await app.inject({
    url: `${prefix}/exchanges/${exchange.id}/archive`,
    headers,
  });
  const archived = externalModelArchiveSchema.parse(storedResponse.json());
  expect(JSON.stringify(archived.sent)).not.toContain('合成客户甲');
  expect(archived.sent).toEqual(fixture.requests[0]);
  expect(archived.sent.provider).toMatchObject({
    zdr: true,
    data_collection: 'deny',
    allow_fallbacks: false,
  });
  expect(archived.sent.tools).toMatchObject([{ type: 'openrouter:web_search' }]);
  expect(archived.returned?.content).toMatch(/\n$/);
  const replay = await app.inject({ url, method: 'POST', headers, payload: body });
  expect(externalModelExchangeSchema.parse(replay.json()).id).toBe(exchange.id);
  expect(fixture.requests).toHaveLength(1);
  const continued = await app.inject({
    url,
    method: 'POST',
    headers,
    payload: { ...message('补充一处核对。'), search: false },
  });
  expect(continued.statusCode).toBe(200);
  expect(fixture.requests[1]?.messages).toHaveLength(3);
  expect(fixture.requests[1]).not.toHaveProperty('tools');
  expect(JSON.stringify(fixture.requests[1])).not.toContain('合成客户甲');
  const other = await context.login('MEMBER_B');
  expect(
    (
      await app.inject({
        url: `${prefix}/exchanges/${exchange.id}/archive`,
        headers: other.headers,
      })
    ).statusCode,
  ).toBe(404);
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const listing = await app.inject({ url: `${prefix}/archive?day=${day}`, headers });
  expect(externalModelArchivePageSchema.parse(listing.json()).items).toHaveLength(2);
  await expect(
    context.pool.query("UPDATE external_model_exchange SET original_text='改写' WHERE id=$1", [
      exchange.id,
    ]),
  ).rejects.toMatchObject({ code: '42501' });
});

test('白名单和本地检查先于派发，月度限额只约束外部入口', async () => {
  await app.close();
  app = withFixture(30_000_000n);
  await seedDevelopmentBudgetPolicy(context.pool, 'test');
  const conversationId = await createConversation();
  const url = `${prefix}/conversations/${conversationId}/messages`;
  const send = (payload: object) => app.inject({ url, method: 'POST', headers, payload });
  expect((await send({ ...message('核对资料。'), model: 'not-listed' })).statusCode).toBe(403);
  expect((await send(message('本地检查拒绝样例'))).json().error.code).toBe(
    'EXTERNAL_LOCAL_CHECK_REJECTED',
  );
  expect(fixture.requests).toHaveLength(0);
  expect((await send(message('核对资料。'))).statusCode).toBe(200);
  expect((await send(message('补充核对。'))).json().error.code).toBe('EXTERNAL_BUDGET_BLOCKED');
  expect(fixture.requests).toHaveLength(1);
  expect((await getBudgetSummary(context.pool)).blockedReason).toBeNull();
  expect((await getBudgetSummary(context.pool)).nightCostNano).toBe('0');
});

test('当日档案跨过 50 条继续读取，其他成员不能使用同一游标', async () => {
  const conversationId = await createConversation();
  await context.pool.query(
    `INSERT INTO external_model_exchange(conversation_id,request_key,request_fingerprint,model,original_text,search,sent,returned,
       answer,replacement_count,month_key,status,reserved_nano,actual_nano,created_at)
     SELECT $1,gen_random_uuid(),repeat('a',64),'external-fixture','合成档案',false,'{}'::jsonb,'{}'::jsonb,
        '合成返回',0,to_char(now() AT TIME ZONE 'Asia/Shanghai','YYYY-MM'),'settled'::external_model_exchange_status,2000,1000,now()
     FROM generate_series(1,52)`,
    [conversationId],
  );
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const url = `${prefix}/archive?day=${day}`;
  const first = externalModelArchivePageSchema.parse((await app.inject({ url, headers })).json());
  expect(first.items).toHaveLength(50);
  expect(first.nextCursor).not.toBeNull();
  const nextUrl = `${url}&cursor=${first.nextCursor}`;
  const next = externalModelArchivePageSchema.parse(
    (await app.inject({ url: nextUrl, headers })).json(),
  );
  expect(next.items).toHaveLength(2);
  expect(next.nextCursor).toBeNull();
  expect(new Set([...first.items, ...next.items].map(({ id }) => id)).size).toBe(52);
  const other = await context.login('MEMBER_B');
  const denied = externalModelArchivePageSchema.parse(
    (await app.inject({ url: nextUrl, headers: other.headers })).json(),
  );
  expect(denied.items).toEqual([]);
});

test('费用未知时保留实际返回和预占，只暂停外部模型', async () => {
  await seedDevelopmentBudgetPolicy(context.pool, 'test');
  const conversationId = await createConversation();
  const url = `${prefix}/conversations/${conversationId}/messages`;
  const send = (text: string) =>
    app.inject({ url, method: 'POST', headers, payload: message(text) });
  const response = await send('费用不明样例');
  expect(response.statusCode).toBe(200);
  const exchange = externalModelExchangeSchema.parse(response.json());
  expect(exchange).toMatchObject({ status: 'unknown', costNano: null, answer: null });
  const archive = await app.inject({ url: `${prefix}/exchanges/${exchange.id}/archive`, headers });
  expect(externalModelArchiveSchema.parse(archive.json()).returned).toEqual({
    content: '缺少用量。',
  });
  const setup = await app.inject({ url: `${prefix}/setup`, headers });
  const { budget } = externalModelSetupSchema.parse(setup.json());
  expect(budget.blocked).toBe(true);
  expect(BigInt(budget.reservedNano)).toBeGreaterThan(0n);
  expect((await send('核对资料。')).json().error.code).toBe('EXTERNAL_BUDGET_BLOCKED');
  expect(fixture.requests).toHaveLength(1);
  expect(await getBudgetSummary(context.pool)).toMatchObject({
    blockedReason: null,
    nightCostNano: '0',
  });
});

test('带入已保存附件，引用时只把脱敏回答交给目标 Agent', async () => {
  await app.close();
  storage = await createTestBlobStore();
  await seedDevelopmentWorkspace(context.pool, storage.store, { NODE_ENV: 'test' });
  app = withFixture();
  const workspace = workspaceRecordSchema.parse(
    (
      await app.inject({
        url: `/api/projects/${context.projectId}/workspace`,
        headers,
      })
    ).json(),
  );
  const added = await app.inject({
    url: `${prefix}/words`,
    method: 'POST',
    headers,
    payload: { phrase: '附件合成客户', category: 'customer' },
  });
  expect(added.statusCode).toBe(200);
  const conversationId = await createConversation();
  const external = await app.inject({
    url: `${prefix}/conversations/${conversationId}/messages`,
    method: 'POST',
    headers,
    payload: {
      ...message('请核对附件合成客户。'),
      attachments: [{ versionId: workspace.currentVersionId, path: 'AGENTS.md' }],
    },
  });
  expect(external.statusCode).toBe(200);
  const exchange = externalModelExchangeSchema.parse(external.json());
  expect(fixture.requests[0]?.messages.at(-1)?.content).toContain('L08 510(k) 项目说明');
  const targetResponse = await app.inject({
    url: `/api/projects/${context.projectId}/conversations`,
    method: 'POST',
    headers,
    payload: {
      requestKey: randomUUID(),
      title: '引用测试',
      goalId: context.goalId,
      agentCode: 'registration',
      permissionMode: 'read_only',
    },
  });
  expect(targetResponse.statusCode).toBe(200);
  const target = targetResponse.json().conversation.id as string;
  const forwarded = await app.inject({
    url: `${prefix}/exchanges/${exchange.id}/share`,
    method: 'POST',
    headers,
    payload: { conversationId: target, requestKey: randomUUID() },
  });
  expect(forwarded.statusCode).toBe(200);
  const quote = (
    await context.pool.query<{ text: string }>(
      "SELECT message_json->>'content' AS text FROM conversation_message WHERE conversation_id=$1",
      [target],
    )
  ).rows[0]!.text;
  expect(quote).toContain('请用项目资料逐条核对');
  expect(quote).toContain('https://example.invalid/external-source');
  expect(quote).not.toContain('附件合成客户');
  const removed = await app.inject({
    url: `${prefix}/words/${added.json().id}`,
    method: 'DELETE',
    headers,
  });
  expect(removed.statusCode).toBe(204);
  expect(
    (await app.inject({ url: `${prefix}/words/${added.json().id}`, method: 'DELETE', headers }))
      .statusCode,
  ).toBe(204);
  expect(
    (
      await context.pool.query('SELECT active FROM external_model_word WHERE id=$1', [
        added.json().id,
      ])
    ).rows[0]?.active,
  ).toBe(false);
});
