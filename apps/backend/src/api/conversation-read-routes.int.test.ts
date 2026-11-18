import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createIntegrationContext } from '../test-support/context.js';
import { appendConversationEvent, appendConversationMessage } from '../conversations/storage.js';

type Context = Awaited<ReturnType<typeof createIntegrationContext>>;
type Frame = { event: string; id?: string; data: Record<string, unknown> };
let c: Context;
let base: string;
const clients = new Set<ReturnType<typeof http.get>>();
beforeAll(async () => {
  c = await createIntegrationContext();
  base = await c.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  for (const client of clients) client.destroy();
  await c?.close();
});
async function connect(path: string, headers: Record<string, string>) {
  return new Promise<{
    frames: Frame[];
    wait(predicate: (frames: Frame[]) => boolean): Promise<void>;
    close(): void;
    ended: Promise<void>;
  }>((resolve, reject) => {
    const frames: Frame[] = [];
    const waiters = new Set<() => void>();
    const request = http.get(`${base}${path}`, { headers }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`SSE状态${response.statusCode}`));
        return;
      }
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.headers['cache-control']).toBe('no-store');
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        buffer += chunk;
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const lines = block.split('\n');
          const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
          if (!data) continue;
          const id = lines.find((line) => line.startsWith('id: '))?.slice(4);
          frames.push({
            event: lines.find((line) => line.startsWith('event: '))?.slice(7) ?? '',
            ...(id ? { id } : {}),
            data: JSON.parse(data) as Record<string, unknown>,
          });
          for (const wake of waiters) wake();
        }
      });
      const ended = new Promise<void>((done) => response.once('close', done));
      resolve({
        frames,
        ended,
        close() {
          request.destroy();
          clients.delete(request);
        },
        async wait(predicate) {
          if (predicate(frames)) return;
          await new Promise<void>((done, fail) => {
            const check = () => {
              if (!predicate(frames)) return;
              clearTimeout(timer);
              waiters.delete(check);
              done();
            };
            const timer = setTimeout(() => {
              waiters.delete(check);
              fail(new Error('SSE验收等待超时'));
            }, 6000);
            waiters.add(check);
          });
        },
      });
    });
    request.on('error', reject);
    clients.add(request);
  });
}
async function event(run: Awaited<ReturnType<Context['run']>>, type = 'tool_completed') {
  return appendConversationEvent(c.pool, {
    runId: run.runId,
    userId: run.userId,
    requestKey: randomUUID(),
    event: {
      type,
      payload: {
        name: 'doc_read',
        data: { text: '不允许公开的旧工具回执' },
        arguments: '旧工具原参数',
      },
    },
  });
}
async function within<T>(promise: Promise<T>, timeout = 6000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('连接未及时结束')), timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
it('真实Cookie鉴权；部门成员共享项目对话且只有发起人显示canWrite', async () => {
  const run = await c.run();
  const a = await c.login();
  const b = await c.login('MEMBER_B');
  const path = `/api/conversations/${run.conversationId}`;
  expect(
    (await c.app.inject({ url: path, headers: { 'sec-fetch-site': 'same-origin' } })).statusCode,
  ).toBe(401);
  expect(
    (
      await c.app.inject({
        url: path,
        headers: { ...b.headers, origin: 'https://untrusted.invalid' },
      })
    ).statusCode,
  ).toBe(403);
  const mine = await c.app.inject({ url: path, headers: a.headers });
  const shared = await c.app.inject({ url: path, headers: b.headers });
  expect(mine.statusCode).toBe(200);
  expect(mine.json().canWrite).toBe(true);
  expect(shared.statusCode).toBe(200);
  expect(shared.json()).toMatchObject({
    canWrite: false,
    userId: run.userId,
    permissionMode: 'ask',
    permissionVersion: 1,
  });
  const listed = await c.app.inject({
    url: `/api/projects/${c.projectId}/conversations`,
    headers: b.headers,
  });
  expect(listed.statusCode).toBe(200);
  expect(listed.json().items.some((item: { id: string }) => item.id === run.conversationId)).toBe(
    true,
  );
  const unassigned = (
    await c.pool.query<{ id: string }>(
      "INSERT INTO conversation(user_id,title) VALUES($1,'项目外合成对话') RETURNING id",
      [run.userId],
    )
  ).rows[0]!.id;
  const outside = await c.app.inject({ url: '/api/conversations', headers: b.headers });
  expect(outside.statusCode).toBe(200);
  expect(outside.json().items.map((item: { id: string }) => item.id)).toContain(unassigned);
  expect(
    outside.json().items.every((item: { projectId: string | null }) => item.projectId === null),
  ).toBe(true);
});
it('历史分页仅给用户/助手文本，工具参数与私有结果从响应彻底排除', async () => {
  const run = await c.run();
  const login = await c.login('MEMBER_B');
  const append = (message: unknown) =>
    appendConversationMessage(c.pool, {
      runId: run.runId,
      userId: run.userId,
      requestKey: randomUUID(),
      message,
    });
  await append({ role: 'user', content: '请检查文字写法' });
  await append({
    role: 'assistant',
    content: '正在核对',
    tool_calls: [
      {
        id: 'call1',
        type: 'function',
        function: { name: 'doc_read', arguments: '{"secret_argument":"不能公开"}' },
      },
    ],
  });
  await append({ role: 'tool', tool_call_id: 'call1', content: 'PRIVATE_RESULT' });
  await append({ role: 'assistant', content: '完成核对' });
  const first = await c.app.inject({
    url: `/api/conversations/${run.conversationId}/messages?limit=1`,
    headers: login.headers,
  });
  expect(first.statusCode).toBe(200);
  expect(first.json().nextAfterSeq).toBe(1);
  const rest = await c.app.inject({
    url: `/api/conversations/${run.conversationId}/messages?afterSeq=1`,
    headers: login.headers,
  });
  expect(rest.statusCode).toBe(200);
  expect(rest.json().items.map((item: { seq: number }) => item.seq)).toEqual([2, 4]);
  expect(rest.body).not.toMatch(/PRIVATE_RESULT|secret_argument|tool_calls|不能公开/);
});
it('实际HTTP SSE按Last-Event-ID回补、实时追加、重放不重复，跨对话通知不串流', async () => {
  const run = await c.run();
  const other = await c.run();
  const login = await c.login('MEMBER_B');
  await event(run);
  await event(run);
  const stream = await connect(
    `/api/conversations/${run.conversationId}/events?afterSeq=1`,
    login.headers,
  );
  try {
    await stream.wait((frames) => frames.length === 1);
    expect(stream.frames.map((frame) => frame.id)).toEqual(['2']);
    const input = {
      runId: run.runId,
      userId: run.userId,
      requestKey: randomUUID(),
      event: { type: 'tool_completed', payload: { name: 'ws_write', data: { text: '私有原文' } } },
    };
    await appendConversationEvent(c.pool, input);
    await appendConversationEvent(c.pool, input);
    await event(other);
    await stream.wait((frames) => frames.length === 2);
    expect(stream.frames.map((frame) => frame.id)).toEqual(['2', '3']);
    expect(JSON.stringify(stream.frames)).not.toMatch(/旧工具回执|旧工具原参数|私有原文|arguments/);
  } finally {
    stream.close();
  }
  await event(run);
  const again = await connect(`/api/conversations/${run.conversationId}/events?afterSeq=0`, {
    ...login.headers,
    'last-event-id': '3',
  });
  try {
    await again.wait((frames) => frames.length === 1);
    expect(again.frames.map((frame) => frame.id)).toEqual(['4']);
  } finally {
    again.close();
  }
});
it('无效游标、超前游标、URL凭据和未登录SSE在发送流头前拒绝', async () => {
  const run = await c.run();
  const login = await c.login();
  const url = `/api/conversations/${run.conversationId}/events`;
  expect(
    (await c.app.inject({ url, headers: { 'sec-fetch-site': 'same-origin' } })).statusCode,
  ).toBe(401);
  for (const cursor of ['-1', '1e3', '9007199254740992', '1,2'])
    expect(
      (await c.app.inject({ url, headers: { ...login.headers, 'last-event-id': cursor } }))
        .statusCode,
    ).toBe(400);
  expect(
    (await c.app.inject({ url, headers: { ...login.headers, 'last-event-id': '1' } })).statusCode,
  ).toBe(409);
  expect(
    (await c.app.inject({ url: `${url}?token=fake`, headers: login.headers })).statusCode,
  ).toBe(400);
  expect(
    (
      await c.app.inject({
        url: `${url}?afterSeq=1e3`,
        headers: { ...login.headers, 'last-event-id': '0' },
      })
    ).statusCode,
  ).toBe(400);
});
it('已打开SSE在注销后关闭，之后的正文不继续发送', async () => {
  const run = await c.run();
  const login = await c.login('MEMBER_B');
  const stream = await connect(`/api/conversations/${run.conversationId}/events`, login.headers);
  try {
    const logout = await c.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: login.headers,
      payload: {},
    });
    expect(logout.statusCode).toBe(204);
    await event(run);
    await within(stream.ended);
    expect(stream.frames).toEqual([]);
  } finally {
    stream.close();
  }
});
it('空闲SSE仍复核会话过期，成员停用后也立即拒读并关闭流', async () => {
  const run = await c.run();
  const login = await c.login('MEMBER_B');
  const stream = await connect(`/api/conversations/${run.conversationId}/events`, login.headers);
  try {
    await c.pool.query("UPDATE app_user SET status='disabled' WHERE id=$1", [c.userId('MEMBER_B')]);
    await within(stream.ended);
    expect(
      (
        await c.app.inject({
          url: `/api/conversations/${run.conversationId}`,
          headers: login.headers,
        })
      ).statusCode,
    ).toBe(401);
    expect(stream.frames).toEqual([]);
  } finally {
    stream.close();
    await c.pool.query("UPDATE app_user SET status='active' WHERE id=$1", [c.userId('MEMBER_B')]);
  }
  const renewed = await c.login('MEMBER_B');
  const expiring = await connect(
    `/api/conversations/${run.conversationId}/events`,
    renewed.headers,
  );
  try {
    await c.pool.query(
      "UPDATE web_session SET created_at=LEAST(created_at,clock_timestamp()-interval '2 minutes'),expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1",
      [c.userId('MEMBER_B')],
    );
    await within(expiring.ended);
    expect(expiring.frames).toEqual([]);
  } finally {
    expiring.close();
  }
});
it('通知流返回有界待处理快照，不混用对话seq也不发送进度', async () => {
  const run = await c.run();
  const login = await c.login();
  const stream = await connect('/api/me/stream', login.headers);
  try {
    await stream.wait((frames) => frames.length >= 1);
    expect(stream.frames[0]?.event).toBe('pending_snapshot');
    expect(stream.frames[0]?.id).toBeUndefined();
    const before = JSON.stringify(stream.frames[0]?.data.items);
    await event(run, 'model_started');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(JSON.stringify(stream.frames[0]?.data.items)).toBe(before);
    expect(stream.frames).toHaveLength(1);
    expect((stream.frames[0]?.data.items as unknown[]).length).toBeLessThanOrEqual(50);
  } finally {
    stream.close();
  }
  expect(
    (
      await c.app.inject({
        url: '/api/me/stream',
        headers: { ...login.headers, 'last-event-id': '1' },
      })
    ).statusCode,
  ).toBe(400);
});
it('连接限额在断开后归还，服务关闭结束长连接并释放监听资源', async () => {
  const run = await c.run();
  const login = await c.login('ADMIN');
  const path = `/api/conversations/${run.conversationId}/events`;
  const opened = [];
  for (let index = 0; index < 5; index++) opened.push(await connect(path, login.headers));
  expect((await c.app.inject({ url: path, headers: login.headers })).statusCode).toBe(429);
  for (const stream of opened) stream.close();
  await Promise.all(opened.map((stream) => within(stream.ended)));
  const last = await connect(path, login.headers);
  await within(c.app.close());
  await within(last.ended);
  last.close();
  expect((await c.pool.query('SELECT 1 AS available')).rows[0]?.available).toBe(1);
});
