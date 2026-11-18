// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { randomUUID } from 'node:crypto';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api, setSessionCredentials } from './api.js';
import { SessionProvider, useSession } from './useSession.js';

const auth = (username = 'zhangsan', csrf = 'a'.repeat(64)) => ({
  user: {
    id: randomUUID(),
    username,
    displayName: username === 'zhangsan' ? '张三' : '王敏',
    isManagement: false,
  },
  csrfToken: csrf,
  expiresAt: '2026-11-19T00:00:00.000Z',
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const rejected = () =>
  json(
    { error: { code: 'LOGIN_REQUIRED', message: '请重新登录。', requestId: randomUUID() } },
    401,
  );
const setup = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(SessionProvider, { children }),
    );
  return { ...renderHook(() => useSession(), { wrapper }), queryClient };
};
afterEach(() => {
  cleanup();
  setSessionCredentials(null);
  vi.unstubAllGlobals();
});
it('未登录启动正常显示登录状态，登录成功保留内存会话、注销清空缓存和写凭据', async () => {
  const session = auth();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(rejected())
    .mockResolvedValueOnce(json(session))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetcher);
  const hook = setup();
  await waitFor(() => expect(hook.result.current.status).toBe('anonymous'));
  expect(hook.result.current.error).toBeNull();
  await act(async () => hook.result.current.login('zhangsan', 'fixture-development-password'));
  expect(hook.result.current.status).toBe('authenticated');
  expect(hook.result.current.session?.user.displayName).toBe('张三');
  hook.queryClient.setQueryData(['private'], { text: '旧账号对话' });
  await act(async () => hook.result.current.logout());
  expect(hook.result.current.session).toBeNull();
  expect(hook.queryClient.getQueryData(['private'])).toBeUndefined();
  await expect(
    api.send(randomUUID(), { requestKey: randomUUID(), text: '退出后不得写入' }),
  ).rejects.toMatchObject({ status: 401 });
  expect(fetcher.mock.calls).toHaveLength(3);
});
it('新的登录成功后，迟到的初始me不能覆盖当前账号', async () => {
  let respond!: (response: Response) => void;
  const old = auth(),
    current = auth('wangmin', 'b'.repeat(64));
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    )
    .mockResolvedValueOnce(json(current));
  vi.stubGlobal('fetch', fetcher);
  const hook = setup();
  await act(async () => hook.result.current.login('wangmin', 'fixture-development-password'));
  await act(async () => {
    respond(json(old));
  });
  expect(hook.result.current.session?.user.username).toBe('wangmin');
});
it('登录失效统一清空身份及私有查询缓存', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json(auth())).mockResolvedValueOnce(rejected());
  vi.stubGlobal('fetch', fetcher);
  const hook = setup();
  await waitFor(() => expect(hook.result.current.status).toBe('authenticated'));
  hook.queryClient.setQueryData(['private'], { text: '受保护正文' });
  await act(async () => {
    await api.me().catch(() => undefined);
  });
  expect(hook.result.current.status).toBe('anonymous');
  expect(hook.result.current.session).toBeNull();
  expect(hook.queryClient.getQueryData(['private'])).toBeUndefined();
});
