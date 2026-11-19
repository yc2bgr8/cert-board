import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError, setSessionCredentials, subscribeSessionExpired } from './api.js';
const id = randomUUID(),
  runId = randomUUID(),
  messageId = randomUUID();
const session = (csrf = 'a'.repeat(64)) => ({
  user: { id, username: 'zhangsan', displayName: '张三', isManagement: false },
  csrfToken: csrf,
  expiresAt: '2026-11-19T00:00:00.000Z',
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const result = {
  conversationId: id,
  runId,
  messageId,
  steeringId: null,
  answerId: null,
  kind: 'queued',
  replayed: false,
};
afterEach(() => {
  setSessionCredentials(null);
  vi.unstubAllGlobals();
});
it('写请求只用内存CSRF和同源Cookie，不在URL或正文夹带凭据', async () => {
  const fetcher = vi.fn().mockResolvedValue(json(result));
  vi.stubGlobal('fetch', fetcher);
  const input = { requestKey: randomUUID(), text: '检查原文' };
  await expect(api.send(id, input)).rejects.toMatchObject({ status: 401 });
  expect(fetcher.mock.calls).toHaveLength(0);
  setSessionCredentials(session());
  await api.send(id, input);
  const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
  expect(url).toBe(`/api/conversations/${id}/messages`);
  expect(init.credentials).toBe('same-origin');
  expect(new Headers(init.headers).get('x-csrf-token')).toBe(session().csrfToken);
  expect(JSON.parse(String(init.body))).toEqual(input);
  expect(url).not.toContain('token');
});
it('变参、伪造身份和外部路径在fetch前拒绝，409不自动重发', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      json(
        { error: { code: 'VERSION_CONFLICT', message: '请刷新后重试。', requestId: randomUUID() } },
        409,
      ),
    );
  vi.stubGlobal('fetch', fetcher);
  setSessionCredentials(session());
  expect(() => api.conversation('https://external.invalid')).toThrow(ApiError);
  expect(() =>
    api.send(id, { requestKey: randomUUID(), text: '测试', userId: randomUUID() } as never),
  ).toThrow(ApiError);
  expect(fetcher.mock.calls).toHaveLength(0);
  await expect(api.send(id, { requestKey: randomUUID(), text: '测试' })).rejects.toMatchObject({
    status: 409,
    code: 'VERSION_CONFLICT',
  });
  expect(fetcher.mock.calls).toHaveLength(1);
});
it('网络和无效响应只返回固定中文错误，不回显底层或原始返回体', async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error('底层私有连接和token'))
    .mockResolvedValueOnce(json({ privateResponse: '不能回显' }));
  vi.stubGlobal('fetch', fetcher);
  await expect(api.me()).rejects.toMatchObject({ code: 'NETWORK_UNAVAILABLE' });
  try {
    await api.me();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as Error).message).not.toMatch(/底层|token|不能回显/);
  }
});
it('旧身份请求迟到401不能清除新登录凭据', async () => {
  let respond!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    )
    .mockResolvedValueOnce(json(result));
  vi.stubGlobal('fetch', fetcher);
  setSessionCredentials(session());
  const expired = vi.fn();
  const unsubscribe = subscribeSessionExpired(expired);
  try {
    const old = api.conversation(id);
    setSessionCredentials(session('b'.repeat(64)));
    respond(
      json(
        { error: { code: 'LOGIN_REQUIRED', message: '请登录。', requestId: randomUUID() } },
        401,
      ),
    );
    await expect(old).rejects.toMatchObject({ status: 401 });
    expect(expired.mock.calls).toHaveLength(0);
    await api.send(id, { requestKey: randomUUID(), text: '新身份请求' });
    const init = fetcher.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('x-csrf-token')).toBe('b'.repeat(64));
  } finally {
    unsubscribe();
  }
});
it('证据位置和文件路径精确编码，版本与续读参数保留，路径穿越在请求前拒绝', async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(async () =>
      json(
        { error: { code: 'NOT_FOUND', message: '测试对象不存在。', requestId: randomUUID() } },
        404,
      ),
    );
  vi.stubGlobal('fetch', fetcher);
  await api.documentPage(id, 2, 7, { offset: 8010, limit: 12000 }).catch(() => undefined);
  const documentUrl = new URL(String(fetcher.mock.calls[0]?.[0]), 'http://127.0.0.1');
  expect(documentUrl.pathname).toBe(`/api/documents/${id}/versions/2/pages/7`);
  expect(documentUrl.searchParams.get('offset')).toBe('8010');
  await api
    .workspaceFile(id, '交付/报告 空格.md', { versionId: runId, offset: 12, limit: 100 })
    .catch(() => undefined);
  const fileUrl = String(fetcher.mock.calls[1]?.[0]);
  expect(fileUrl).toContain(encodeURIComponent('交付') + '/' + encodeURIComponent('报告 空格.md'));
  expect(new URL(fileUrl, 'http://127.0.0.1').searchParams.get('versionId')).toBe(runId);
  expect(() => api.workspaceFile(id, '../凭据', { versionId: runId })).toThrow(ApiError);
  expect(fetcher.mock.calls).toHaveLength(2);
});
it('最终审核提交明确版本和浏览器CSRF，不接受模型伪造字段', async () => {
  const snapshotId = randomUUID();
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      json({
        cardId: id,
        status: 'approved',
        version: 2,
        decisionId: randomUUID(),
        snapshotId,
        replayed: false,
      }),
    );
  vi.stubGlobal('fetch', fetcher);
  setSessionCredentials(session());
  const input = {
    requestKey: randomUUID(),
    expectedVersion: 1,
    workspaceVersion: runId,
    action: 'approved' as const,
    reason: null,
  };
  await api.decideReview(id, input);
  expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/reviews/${id}/decision`);
  const init = fetcher.mock.calls[0]?.[1] as RequestInit;
  expect(JSON.parse(String(init.body))).toEqual(input);
  expect(new Headers(init.headers).has('x-csrf-token')).toBe(true);
  expect(() => api.decideReview(id, { ...input, actorKind: 'agent' } as never)).toThrow(ApiError);
  expect(fetcher.mock.calls).toHaveLength(1);
});
