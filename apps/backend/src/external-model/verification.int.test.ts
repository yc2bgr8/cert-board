import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  gatewayResponseSchema,
  verificationDetailSchema,
  verificationRoomSchema,
  verificationSettingsSchema,
} from '@cert-board/shared';
import { createApp } from '../app.js';
import { createIntegrationContext } from '../test-support/context.js';
import { verificationFixture } from '../test-support/verification-fixture.js';
import { createVerificationModerator } from './verification-moderator.js';
import { ExternalModels } from './service.js';

const prefix = '/api/verification';
let context: Awaited<ReturnType<typeof createIntegrationContext>>;
let app: ReturnType<typeof createApp>;
let fixture: ReturnType<typeof verificationFixture>;
let headers: Awaited<ReturnType<typeof context.login>>['headers'];

beforeEach(async () => {
  context = await createIntegrationContext();
  fixture = verificationFixture();
  app = createApp(context.config, {
    database: context.pool,
    verificationRuntime: fixture.runtime,
    checkDatabase: async () => undefined,
    checkStorage: async () => undefined,
    close: async () => undefined,
  });
  headers = (await context.login()).headers;
});
afterEach(async () => {
  await app?.close();
  await context?.close();
});

async function start(question: string, projectId?: string) {
  const payload = { requestKey: randomUUID(), question, projectId };
  const answer = await app.inject({ method: 'POST', url: `${prefix}/rooms`, headers, payload });
  expect(answer.statusCode).toBe(200);
  const room = verificationRoomSchema.parse(answer.json());
  const repeat = await app.inject({ method: 'POST', url: `${prefix}/rooms`, headers, payload });
  expect(verificationRoomSchema.parse(repeat.json()).id).toBe(room.id);
  return room.id;
}

async function detail(id: string, actor = headers) {
  const result = await app.inject({ url: `${prefix}/rooms/${id}`, headers: actor });
  expect(result.statusCode).toBe(200);
  return verificationDetailSchema.parse(result.json());
}

async function speak(id: string, text: string, mention: string | null, actor = headers) {
  const url = `${prefix}/rooms/${id}/posts`;
  const payload = { requestKey: randomUUID(), text, mention };
  for (const request of [payload, payload]) {
    expect(
      (await app.inject({ method: 'POST', url, headers: actor, payload: request })).statusCode,
    ).toBe(204);
  }
}

async function rounds(value: number) {
  const settings = verificationSettingsSchema.parse(
    (await app.inject({ headers, url: `${prefix}/settings` })).json(),
  );
  const payload = { autoRounds: value, models: settings.models };
  const url = `${prefix}/settings`;
  expect((await app.inject({ method: 'PUT', url, headers, payload })).statusCode).toBe(403);
  const administrator = await context.login('ADMIN');
  const changed = await app.inject({ method: 'PUT', url, headers: administrator.headers, payload });
  expect(verificationSettingsSchema.parse(changed.json()).autoRounds).toBe(value);
}

test('按默认 7 轮和管理员设置的 3 轮调度，通道只记次数', async () => {
  for (const cap of [7, 3]) {
    if (cap !== 7) await rounds(cap);
    const room = await start(`第 ${cap} 轮限制的合成核实。`);
    await expect
      .poll(async () => (await detail(room)).room.status, { timeout: 12000 })
      .toBe('completed');
    const result = await detail(room);
    const modelTurns = result.messages.filter(({ type }) => type === 'model');
    expect(modelTurns).toHaveLength(2 * cap);
    for (const { id } of result.participants)
      expect(modelTurns.filter(({ model }) => model === id).map(({ round }) => round)).toEqual(
        Array.from({ length: cap }, (_, position) => position + 1),
      );
    expect(result.conclusion?.items.map(({ category }) => category)).toEqual([
      'trusted',
      'disputed',
      'unverified',
    ]);
  }
  const settings = verificationSettingsSchema.parse(
    (await app.inject({ headers, url: `${prefix}/settings` })).json(),
  );
  expect(settings.usage.map(({ calls }) => calls)).toEqual([10, 10]);
  const ledger = await context.pool.query(
    "SELECT actual_nano FROM external_model_exchange WHERE channel='cursor' AND actual_nano<>0",
  );
  expect(ledger.rows).toEqual([]);
}, 25000);

test('群里直接插话和点名，当前回答照常完成，停止后继续并重新整理', async () => {
  let started!: () => void;
  const entering = new Promise<void>((resolve) => {
    started = resolve;
  });
  let deliver!: () => void;
  const released = new Promise<void>((resolve) => {
    deliver = resolve;
  });
  const send = fixture.runtime.send;
  let calls = 0;
  fixture.runtime.send = async (model, prompt) => {
    if (++calls === 1) {
      started();
      await released;
    }
    return send(model, prompt);
  };
  const other = await context.login('MEMBER_B');
  const word = await app.inject({
    url: '/api/external-model/words',
    method: 'POST',
    headers,
    payload: { phrase: '合成客户甲', category: 'customer' },
  });
  expect(word.statusCode).toBe(200);
  const room = await start('请核对合成客户甲的合成清单。', context.projectId);
  await entering;
  try {
    await speak(
      room,
      '补充说明：这是合成客户甲的新需求。剧本：注入',
      'claude-flagship',
      other.headers,
    );
    const inFlight = await detail(room, other.headers);
    expect(inFlight.room.activeModel).toBe('gpt-flagship');
    expect(inFlight.messages.at(-1)?.text).toContain('补充说明');
  } finally {
    deliver();
  }
  await expect
    .poll(async () => (await detail(room)).messages.filter(({ type }) => type === 'model').length)
    .toBe(2);
  expect(fixture.requests[1]?.model).toBe('claude-flagship');
  const second = fixture.requests[1]?.prompt;
  expect(second?.transcript.map(({ role }) => role)).toContain('gpt-flagship 第1轮');
  expect(JSON.stringify(second)).toContain('补充说明');
  expect(JSON.stringify(second)).not.toContain('合成客户甲');
  const current = await detail(room);
  const raw = await context.pool.query<{ sent: object; returned: object }>(
    'SELECT sent,returned FROM external_model_exchange WHERE id=$1',
    [current.messages.at(-1)?.archiveId],
  );
  expect(raw.rows[0]?.sent).toEqual({ model: 'claude-flagship', channel: 'cursor', ...second });
  expect(raw.rows[0]?.returned).toHaveProperty('tool_calls');
  await speak(room, '请主持人回应人的补充。', 'host', other.headers);
  await expect.poll(async () => (await detail(room)).messages.at(-1)?.type).toBe('host');
  const stop = `${prefix}/rooms/${room}/stop`;
  expect((await app.inject({ method: 'POST', url: stop, headers: other.headers })).statusCode).toBe(
    204,
  );
  await expect.poll(async () => (await detail(room)).room.status).toBe('completed');
  const stopped = await detail(room);
  expect(stopped.messages.at(-1)?.text).toContain('中途停止');
  expect(stopped.conclusion?.items.some(({ category }) => category === 'human')).toBe(true);
  await speak(room, '继续询问GPT。', 'gpt-flagship');
  await expect
    .poll(async () => (await detail(room)).messages.filter(({ type }) => type === 'model').length)
    .toBe(3);
  expect((await detail(room)).room.status).toBe('discussing');
  expect((await app.inject({ method: 'POST', url: stop, headers })).statusCode).toBe(204);
  await expect.poll(async () => (await detail(room)).room.status).toBe('completed');
  expect(
    (await detail(room)).conclusion?.items.some(({ statement }) =>
      statement.includes('继续询问GPT'),
    ),
  ).toBe(true);
}, 18000);

test('未关联项目的核实仅发起人可看，真实通道未就绪时允许保存在本地', async () => {
  const other = await context.login('MEMBER_B');
  const result = await context.app.inject({
    method: 'POST',
    url: `${prefix}/rooms`,
    headers,
    payload: { requestKey: randomUUID(), question: '单人的合成核实记录。' },
  });
  const { id, status } = verificationRoomSchema.parse(result.json());
  expect(status).toBe('paused');
  expect(
    (await app.inject({ url: `${prefix}/rooms/${id}`, headers: other.headers })).statusCode,
  ).toBe(404);
  expect((await detail(id)).messages.some(({ type }) => type === 'system')).toBe(true);
  expect(fixture.requests).toHaveLength(0);
});

test('主模型主持使用已有本人目标和主网关，先替换保密词且关闭工具', async () => {
  const review = await context.run('MEMBER_A', 'read_only');
  const id = await start('合成主持结论验证。', context.projectId);
  const room = (await detail(id)).room;
  await app.inject({
    method: 'POST',
    url: '/api/external-model/words',
    headers,
    payload: { phrase: '主持测试客户', category: 'customer' },
  });
  const complete = vi.fn(async (request: unknown, caller: unknown) => {
    expect(JSON.stringify(request)).not.toContain('主持测试客户');
    expect(JSON.stringify(request)).toMatch(/CB-[0-9a-f-]+-1/u);
    expect(request).toMatchObject({ tool_choice: 'none' });
    expect(caller).toMatchObject({
      conversationId: review.conversationId,
      userId: review.userId,
      purpose: 'agent',
    });
    return gatewayResponseSchema.parse({
      requestKey: randomUUID(),
      model: 'qwen-flash',
      upstreamModel: 'fixture/qwen',
      message: {
        role: 'assistant',
        content: '{"text":"请 GPT 检查。","call":"gpt-flagship","finish":false}',
      },
      finishReason: 'stop',
      usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1, totalTokens: 2, costNano: '0' },
      dataLevel: 'internal',
    });
  });
  const policy = new ExternalModels(context.pool, undefined, undefined, 20_000_000_000n);
  const moderator = createVerificationModerator(context.pool, { complete }, policy);
  const human = (await detail(id)).messages[0]!;
  const input = {
    room,
    ownerId: review.userId,
    eligible: fixture.runtime.catalog,
    attempts: {},
    transcript: [{ ...human, text: '请核对主持测试客户。' }],
    activeHuman: null,
  };
  expect(await moderator.moderate(input)).toMatchObject({ call: 'gpt-flagship', finish: false });
  expect(await moderator.moderate({ ...input, room: { ...room, projectId: null } })).toBeNull();
  expect(complete).toHaveBeenCalledTimes(1);
  expect(
    (
      await context.pool.query(
        "SELECT status FROM run WHERE conversation_id=$1 AND trigger_type='evaluation'",
        [review.conversationId],
      )
    ).rows,
  ).toEqual([{ status: 'completed' }]);
});
