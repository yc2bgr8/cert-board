import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  gatewayResponseSchema,
  verificationDetailSchema,
  verificationRoomSchema,
  verificationSettingsSchema,
} from '@cert-board/shared';
import { createApp } from '../app.js';
import { AppError } from '../api/errors.js';
import { recoverAbandonedAgentRuns } from '../queue/agent-queue.js';
import { createIntegrationContext } from '../test-support/context.js';
import { verificationFixture } from '../test-support/verification-fixture.js';
import { createVerificationModerator } from './verification-moderator.js';
import { ExternalModels } from './service.js';
import { createVerificationSourceChecker } from './source-verification.js';
import { VerificationRooms, verificationWorkerStateId } from './verification-service.js';
import { VerificationChannelError, type VerificationPrompt } from './verification-runtime.js';

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
      'unverified',
      'unverified',
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

test('带项目的正常核实验证引用，保留摘录不符和链接打不开两种待核实状态', async () => {
  const knownUrl = 'https://www.fda.gov/verification-guide';
  const unavailableUrl = 'https://www.fda.gov/unavailable-guide';
  const sourceText = '示例清单明确要求填写版本号。';
  const document = Buffer.from(`<p>${sourceText}</p>`);
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const blobs = new Map<string, Buffer>();
  const fetchPage = vi.fn(async (url: string) => {
    if (url === unavailableUrl)
      throw new AppError(502, 'FETCH_UPSTREAM_STATUS', '公开地址暂不可用。');
    return {
      url,
      title: '合成网页资料',
      text: sourceText,
      truncated: false,
      mediaType: 'text/html' as const,
      fetchedAt: new Date().toISOString(),
      sha256: digest(document),
      bodyBase64: document.toString('base64'),
    };
  });
  fixture.runtime.checkSources = createVerificationSourceChecker(
    context.pool,
    {
      async put(body) {
        const sha256 = digest(body);
        blobs.set(sha256, Buffer.from(body));
        return { sha256, byteSize: body.byteLength };
      },
      async get(hash) {
        const body = blobs.get(hash);
        if (body) return body;
        throw new Error('TEST_ARCHIVE_MISSING');
      },
    },
    { fetchPage },
  );
  fixture.runtime.send = async (_model, _prompt, dispatch) => {
    await dispatch();
    return {
      text: '合成答复，附三个可区分的出处结果。',
      claims: [
        {
          issue: '版本号',
          statement: sourceText,
          stance: 'supports',
          sources: [{ title: '合成网页资料', url: knownUrl, excerpt: sourceText }],
        },
        {
          issue: '虚构编号',
          statement: '不应当采信的编号。',
          stance: 'supports',
          sources: [{ title: '合成网页资料', url: knownUrl, excerpt: '网页中没有该编号。' }],
        },
        {
          issue: '无法打开',
          statement: '不应当采信的期限。',
          stance: 'supports',
          sources: [{ title: '暂不可用的资料', url: unavailableUrl, excerpt: '未核实的期限。' }],
        },
      ],
    };
  };
  await rounds(1);
  const roomId = await start('核实合成版本号与两条待核实声明。', context.projectId);
  await expect.poll(async () => (await detail(roomId)).room.status).toBe('completed');
  const { conclusion } = await detail(roomId);
  expect(conclusion?.items.map(({ category }) => category)).toEqual([
    'trusted',
    'unverified',
    'unverified',
  ]);
  const checks = conclusion!.items.map((item) => item.evidence[0]?.sources[0]?.check);
  expect(checks.map((check) => check?.status)).toEqual([
    'verified',
    'excerpt_mismatch',
    'source_unavailable',
  ]);
  const verified = checks[0];
  if (verified?.status !== 'verified') throw new Error('TEST_PROOF_MISSING');
  const page = await app.inject({
    url: `/api/documents/${verified.documentId}/versions/${verified.version}/pages/1`,
    headers,
  });
  expect(page.json()).toMatchObject({
    text: sourceText,
    webArchive: { url: knownUrl, sha256: digest(document) },
  });
  expect(blobs.get(verified.sha256)).toEqual(document);
  expect(fetchPage.mock.calls.map(([url]) => url)).toEqual([knownUrl, unavailableUrl]);
  await context.pool.query(
    "UPDATE document SET voided=true,void_reason='测试作废',version=version+1 WHERE id=$1",
    [verified.documentId],
  );
  const revoked = (await detail(roomId)).conclusion;
  expect(revoked?.items[0]).toMatchObject({ category: 'unverified' });
  expect(revoked?.items[0]?.evidence[0]?.sources[0]?.check).toEqual({
    status: 'source_unavailable',
  });
});

test('本地模型出网检查拒绝后，已替换的内容仍不发给 Cursor', async () => {
  const guard = vi.fn(async (_scope: unknown, _prompt: VerificationPrompt) => false);
  const send = vi.fn(fixture.runtime.send);
  fixture.runtime.checkOutbound = guard;
  fixture.runtime.send = send;
  expect(
    (
      await app.inject({
        url: '/api/external-model/words',
        method: 'POST',
        headers,
        payload: { phrase: '合成仅供内部研究', category: 'other' },
      })
    ).statusCode,
  ).toBe(200);
  await rounds(1);
  const roomId = await start('检查合成仅供内部研究的假设。', context.projectId);
  await expect.poll(async () => (await detail(roomId)).room.status).toBe('completed');
  expect(guard).toHaveBeenCalled();
  expect(JSON.stringify(guard.mock.calls[0]?.[1])).toContain('CB-');
  expect(JSON.stringify(guard.mock.calls[0]?.[1])).not.toContain('合成仅供内部研究');
  expect(send).not.toHaveBeenCalled();
  const result = await detail(roomId);
  expect(result.messages.some(({ text }) => text.includes('本地出网检查未通过'))).toBe(true);
  const count = await context.pool.query(
    'SELECT id FROM external_model_exchange WHERE conversation_id=$1 AND dispatched_at IS NOT NULL',
    [roomId],
  );
  expect(count.rowCount).toBe(0);
});

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
  fixture.runtime.send = (model, prompt, dispatch) =>
    send(model, prompt, async () => {
      await dispatch();
      if (++calls === 1) {
        started();
        await released;
      }
    });
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
    const { runId } = caller as { runId: string };
    await recoverAbandonedAgentRuns(context.pool);
    const during = await context.pool.query('SELECT status,lease_owner FROM run WHERE id=$1', [
      runId,
    ]);
    expect(during.rows[0]).toEqual({ status: 'running', lease_owner: expect.any(String) });
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
  const reviewer = await context.run('MEMBER_B', 'read_only');
  const linked = await moderator.moderate({
    ...input,
    ownerId: reviewer.userId,
    room: {
      ...room,
      origin: {
        kind: 'review',
        conversationId: review.conversationId,
        runId: review.runId,
        reviewId: randomUUID(),
      },
    },
  });
  expect(linked).toMatchObject({ call: 'gpt-flagship', finish: false });
  expect(complete).toHaveBeenCalledTimes(2);
  expect(
    (
      await context.pool.query(
        "SELECT status FROM run WHERE conversation_id=$1 AND trigger_type='evaluation'",
        [review.conversationId],
      )
    ).rows,
  ).toEqual([{ status: 'completed' }, { status: 'completed' }]);

  const localResponse = gatewayResponseSchema.parse({
    requestKey: randomUUID(),
    model: 'deepseek-local',
    upstreamModel: 'fixture/local',
    message: { role: 'assistant', content: '{"allowed":true}' },
    finishReason: 'stop',
    usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1, totalTokens: 2, costNano: '0' },
    dataLevel: 'internal',
  });
  complete.mockResolvedValueOnce(localResponse);
  const pending = {
    instructions: '合成检查',
    transcript: [{ role: '注册人员', text: `${'合'.repeat(2000)}文末也检查` }],
  };
  expect(await moderator.checkOutbound(input, pending, 'deepseek-local')).toBe(true);
  expect(complete.mock.lastCall?.[0]).toMatchObject({
    model: 'deepseek-local',
    tool_choice: 'none',
  });
  expect(JSON.stringify(complete.mock.lastCall?.[0])).toContain('文末也检查');
  complete.mockResolvedValueOnce(localResponse);
  expect(
    await moderator.checkOutbound(
      { ...input, room: { ...room, projectId: null } },
      pending,
      'deepseek-local',
    ),
  ).toBe(true);
  expect(complete.mock.lastCall?.[1]).toMatchObject({
    userId: review.userId,
    conversationId: review.conversationId,
  });
  complete.mockResolvedValueOnce({
    ...localResponse,
    message: { role: 'assistant', content: '{"allowed":false}' },
  });
  expect(await moderator.checkOutbound(input, pending, 'deepseek-local')).toBe(false);
});

test('握手期间停用模型后不发送，计次和当日外发档案排除未发送', async () => {
  await rounds(1);
  let startHandshake!: () => void;
  let allowContinuation!: () => void;
  const handshake = new Promise<void>((resolve) => {
    startHandshake = resolve;
  });
  const permission = new Promise<void>((resolve) => {
    allowContinuation = resolve;
  });
  const send = fixture.runtime.send;
  fixture.runtime.send = async (model, prompt, dispatch) => {
    if (model.id === 'gpt-flagship') {
      startHandshake();
      await permission;
    }
    return send(model, prompt, dispatch);
  };
  const id = await start('合成：停用模型时复核派发。');
  await handshake;
  const administrator = await context.login('ADMIN');
  try {
    const url = `${prefix}/settings`;
    const current = verificationSettingsSchema.parse((await app.inject({ url, headers })).json());
    const pendingGateway = current.models.map((model) => ({ ...model, channel: 'gateway' }));
    expect(
      (
        await app.inject({
          url,
          method: 'PUT',
          headers: administrator.headers,
          payload: { autoRounds: 1, models: pendingGateway },
        })
      ).statusCode,
    ).toBe(409);
    const models = current.models.map((model) =>
      model.id === 'gpt-flagship' ? { ...model, enabled: false, defaultParticipant: false } : model,
    );
    expect(
      (
        await app.inject({
          url,
          method: 'PUT',
          headers: administrator.headers,
          payload: { autoRounds: 1, models },
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    allowContinuation();
  }
  await expect.poll(async () => (await detail(id)).room.status).toBe('completed');
  expect(fixture.requests.map(({ model }) => model)).toEqual(['claude-flagship']);
  const exchange = await context.pool.query(
    'SELECT model,status,dispatched_at FROM external_model_exchange WHERE conversation_id=$1 ORDER BY created_at',
    [id],
  );
  expect(exchange.rows[0]).toEqual({
    model: 'gpt-flagship',
    status: 'not_sent',
    dispatched_at: null,
  });
  const usage = verificationSettingsSchema.parse(
    (await app.inject({ url: `${prefix}/settings`, headers })).json(),
  ).usage;
  expect(usage).toEqual([{ model: 'claude-flagship', calls: 1 }]);
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const entries = await app.inject({ url: `/api/external-model/archive?day=${day}`, headers });
  expect(entries.json().items.map(({ model }: { model: string }) => model)).toEqual([
    'claude-flagship',
  ]);
});

test('主模型提前要求结束仍邀请各默认模型，畸形回执和换回超长回执仍按原样保存', async () => {
  await rounds(1);
  const word = '保'.repeat(120);
  await app.inject({
    method: 'POST',
    url: '/api/external-model/words',
    headers,
    payload: { phrase: word, category: 'other' },
  });
  const invalid = { providerText: '合成原始回执', text: '可读取答复', claims: [39] };
  fixture.runtime.moderate = async () => ({ text: '准备整理。', call: null, finish: true });
  fixture.runtime.send = async (model, prompt, dispatch) => {
    await dispatch();
    if (model.id === 'claude-flagship') return invalid;
    const token = JSON.stringify(prompt).match(/\[\[CB-[0-9a-f-]+-\d+\]\]/u)?.[0];
    expect(token).toBeDefined();
    return { text: token!.repeat(300), claims: [] };
  };
  const id = await start(`请核对共用词 ${word}。`);
  await expect.poll(async () => (await detail(id)).room.status).toBe('completed');
  const room = await detail(id);
  expect(room.messages.filter(({ type }) => type === 'model')).toEqual([]);
  const { rows } = await context.pool.query(
    'SELECT model,returned FROM external_model_exchange WHERE conversation_id=$1 ORDER BY created_at',
    [id],
  );
  expect(rows).toHaveLength(2);
  expect(rows[0]?.returned.text).toMatch(/\[\[CB-/u);
  expect(rows[1]?.returned).toEqual(invalid);
});

test('额度暂停时可在本地整理，通道复查需要管理员', async () => {
  await context.pool.query(
    "INSERT INTO verification_worker_state(id,worker_id,status) VALUES($1,$2,'quota')",
    [verificationWorkerStateId, randomUUID()],
  );
  const administrator = await context.login('ADMIN');
  const recheck = `${prefix}/settings/recheck`;
  expect((await context.app.inject({ method: 'POST', url: recheck, headers })).statusCode).toBe(
    403,
  );
  expect(
    (await context.app.inject({ method: 'POST', url: recheck, headers: administrator.headers }))
      .statusCode,
  ).toBe(204);
  const created = verificationRoomSchema.parse(
    (
      await context.app.inject({
        method: 'POST',
        url: `${prefix}/rooms`,
        headers,
        payload: { requestKey: randomUUID(), question: '通道暂停时的合成核实。' },
      })
    ).json(),
  );
  expect(created.status).toBe('paused');
  const verification = new VerificationRooms(
    context.pool,
    new ExternalModels(context.pool, undefined, undefined, 20_000_000_000n),
    { ...fixture.runtime, kind: 'cursor', status: 'quota' },
  );
  try {
    expect(
      (
        await context.app.inject({
          method: 'POST',
          url: `${prefix}/rooms/${created.id}/stop`,
          headers,
        })
      ).statusCode,
    ).toBe(204);
    await verification.wakeReady(() => undefined);
    await expect.poll(async () => (await detail(created.id)).room.status).toBe('completed');
    expect(fixture.requests).toHaveLength(0);
  } finally {
    await verification.close();
  }
});

test('按长度整理旧答复，优先保留待处理发言，成功回应会清除旧超时的影响', async () => {
  await rounds(1);
  fixture.runtime.compact = async () => '摘要'.repeat(1900);
  const calls: Array<{ model: string; prompt: VerificationPrompt }> = [];
  let gpt = 0;
  const moderate = fixture.runtime.moderate;
  fixture.runtime.moderate = async (context) => {
    if (context.activeHuman && context.eligible.some(({ id }) => id === 'gpt-flagship'))
      return { text: '请 GPT 回应新问题。', call: 'gpt-flagship', finish: false };
    return moderate(context);
  };
  fixture.runtime.send = async (model, prompt, dispatch) => {
    await dispatch();
    calls.push({ model: model.id, prompt });
    if (model.id === 'gpt-flagship' && gpt++ === 0) throw new VerificationChannelError('timeout');
    return { text: '合成长答复。'.repeat(4000).slice(0, 15500), claims: [] };
  };
  const id = await start('合成长篇核实。');
  await expect.poll(async () => (await detail(id)).room.status).toBe('completed');
  await speak(id, '请 GPT 恢复回答。', 'gpt-flagship');
  await expect
    .poll(
      async () =>
        (await detail(id)).messages.filter(
          ({ model, type }) => model === 'gpt-flagship' && type === 'model',
        ).length,
    )
    .toBe(1);
  const instruction = '接着核对这个新的合成问题。';
  await speak(id, instruction, null);
  await expect.poll(() => calls.length).toBe(4);
  expect(calls.at(-1)?.model).toBe('gpt-flagship');
  expect(calls.at(-1)?.prompt.transcript.some(({ text }) => text === instruction)).toBe(true);
  expect(calls.at(-1)?.prompt.transcript.some(({ text }) => text === '请 GPT 恢复回答。')).toBe(
    true,
  );
  expect(calls.at(-1)?.prompt.transcript.some(({ role }) => role === '主持人压缩稿')).toBe(true);
  expect(
    calls.at(-1)!.prompt.transcript.reduce((size, item) => size + item.text.length, 0),
  ).toBeLessThan(24000);
  expect((await detail(id)).messages.some(({ type }) => type === 'summary')).toBe(true);
});

test('授权后传输明确未写入时不计次，跨月握手用实际派发日期与月份', async () => {
  await rounds(1);
  const send = fixture.runtime.send;
  fixture.runtime.send = (model, prompt, dispatch) =>
    send(model, prompt, async () => {
      await dispatch();
      if (model.id === 'gpt-flagship') throw new VerificationChannelError('failed', true);
    });
  const id = await start('合成：计次和握手中断。');
  await expect.poll(async () => (await detail(id)).room.status).toBe('completed');
  const gpt = await context.pool.query(
    'SELECT status,dispatched_at FROM external_model_exchange WHERE conversation_id=$1 AND model=$2',
    [id, 'gpt-flagship'],
  );
  expect(gpt.rows[0]).toMatchObject({ status: 'not_sent', dispatched_at: expect.any(Date) });
  const saved = await context.pool.query(
    `INSERT INTO external_model_exchange(conversation_id,request_key,request_fingerprint,model,channel,
       original_text,search,sent,returned,replacement_count,month_key,status,reserved_nano,actual_nano,dispatched_at,created_at)
     VALUES($1,gen_random_uuid(),repeat('a',64),'claude-flagship','cursor','合成跨月',false,'{}','{}',0,
       to_char((clock_timestamp() AT TIME ZONE 'Asia/Shanghai')-interval '40 days','YYYY-MM'),'settled',0,0,clock_timestamp(),clock_timestamp()-interval '40 days')
     RETURNING id`,
    [id],
  );
  const monthly = verificationSettingsSchema.parse(
    (await app.inject({ url: `${prefix}/settings`, headers })).json(),
  );
  expect(monthly.usage).toEqual([{ model: 'claude-flagship', calls: 2 }]);
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const dayArchive = await app.inject({ url: `/api/external-model/archive?day=${day}`, headers });
  expect(dayArchive.json().items.map(({ id }: { id: string }) => id)).toContain(saved.rows[0]!.id);
  expect(
    dayArchive.json().items.every(({ model }: { model: string }) => model === 'claude-flagship'),
  ).toBe(true);
});

test('按保密词替换后的长度整理较早回复并继续派发', async () => {
  await rounds(1);
  const word = '隐';
  await app.inject({
    method: 'POST',
    url: '/api/external-model/words',
    headers,
    payload: { phrase: word, category: 'other' },
  });
  const calls: VerificationPrompt[] = [];
  const oldReply = '较早的答复已归档。';
  const originalEvidence = '较早发言的原始证据。';
  fixture.runtime.compact = async () => (oldReply + '页'.repeat(3800)).slice(0, 3799) + word;
  fixture.runtime.send = async (model, prompt, dispatch) => {
    await dispatch();
    calls.push(prompt);
    return {
      text: model.id === 'gpt-flagship' ? originalEvidence + word.repeat(650) : '核实已完成。',
      claims: [],
    };
  };
  const id = await start('合成问题保持原话。');
  await expect.poll(async () => (await detail(id)).room.status).toBe('completed');
  expect(calls).toHaveLength(2);
  const summary = calls[1]!.transcript.find(({ role }) => role === '主持人压缩稿')?.text;
  expect(summary?.startsWith(oldReply)).toBe(true);
  expect(summary!.length).toBeGreaterThan(3700);
  expect(summary!.length).toBeLessThanOrEqual(3800);
  expect(calls[1]!.transcript.some(({ text }) => text === '合成问题保持原话。')).toBe(true);
  expect(
    calls[1]!.transcript
      .map(({ text }) => text)
      .join('')
      .includes(word),
  ).toBe(false);
  let rebuilt = false;
  fixture.runtime.compact = async (records) => {
    rebuilt = records.some(({ text }) => text.includes(originalEvidence));
    return '根据原记录重建的摘要。';
  };
  const changed = await app.inject({
    method: 'POST',
    url: '/api/external-model/words',
    headers,
    payload: { phrase: '新的未引用保密词', category: 'other' },
  });
  expect(changed.statusCode).toBe(200);
  await speak(id, '请根据原记录继续核实。', 'claude-flagship');
  await expect.poll(() => calls.length).toBe(3);
  expect(rebuilt).toBe(true);
  expect(calls[2]!.transcript.some(({ text }) => text === '根据原记录重建的摘要。')).toBe(true);
  expect(calls[2]!.transcript.some(({ text }) => text.includes(oldReply))).toBe(false);
});

test('多次重复同一保密词时按实际代号长度判断原话可以发送', async () => {
  await rounds(1);
  const word = '隐';
  await app.inject({
    method: 'POST',
    url: '/api/external-model/words',
    headers,
    payload: { phrase: word, category: 'other' },
  });
  const prompts: VerificationPrompt[] = [];
  fixture.runtime.send = async (_model, prompt, dispatch) => {
    await dispatch();
    prompts.push(prompt);
    return { text: '短答复。', claims: [] };
  };
  const question = word.repeat(424);
  const room = await start(question);
  await expect.poll(async () => (await detail(room)).room.status).toBe('completed');
  expect(prompts).toHaveLength(2);
  expect(prompts[0]!.transcript[0]!.text).not.toContain(word);
  expect(prompts[0]!.transcript[0]!.text.length).toBeLessThan(22000);
  expect((await detail(room)).messages[0]!.text).toBe(question);
});

test('词表在握手期间变化时丢弃旧发送计划，再按最新规则继续', async () => {
  await rounds(1);
  await app.inject({
    method: 'POST',
    url: '/api/external-model/words',
    headers,
    payload: { phrase: '隐', category: 'other' },
  });
  const newlyProtected = '多字短保密词';
  const firstHostText = '页'.repeat(598) + newlyProtected;
  const moderate = fixture.runtime.moderate;
  fixture.runtime.moderate = async (context) =>
    context.attempts['gpt-flagship']
      ? moderate(context)
      : { text: firstHostText, call: 'gpt-flagship', finish: false };
  let handshakeReady!: () => void;
  let allowDispatch!: () => void;
  const handshake = new Promise<void>((resolve) => {
    handshakeReady = resolve;
  });
  const authorization = new Promise<void>((resolve) => {
    allowDispatch = resolve;
  });
  const send = fixture.runtime.send;
  fixture.runtime.send = async (model, prompt, dispatch) => {
    if (model.id === 'gpt-flagship') {
      handshakeReady();
      await authorization;
    }
    return send(model, prompt, dispatch);
  };
  const id = await start('隐'.repeat(520));
  await handshake;
  try {
    const changed = await app.inject({
      method: 'POST',
      url: '/api/external-model/words',
      headers,
      payload: { phrase: newlyProtected, category: 'other' },
    });
    expect(changed.statusCode).toBe(200);
  } finally {
    allowDispatch();
  }
  await expect.poll(async () => (await detail(id)).room.status).toBe('completed');
  expect(fixture.requests.map(({ model }) => model)).toEqual(['claude-flagship']);
  const outbound = fixture.requests[0]!.prompt.transcript.map(({ text }) => text).join('\n');
  expect(outbound).not.toContain('页'.repeat(25));
  expect(outbound).not.toContain(newlyProtected);
  expect(
    (await detail(id)).messages.some(({ type, text }) => type === 'host' && text === firstHostText),
  ).toBe(true);
});
