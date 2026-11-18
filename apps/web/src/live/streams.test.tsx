// @vitest-environment jsdom
import { randomUUID } from 'node:crypto';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useConversationStream } from './useConversationStream.js';
import { useMemberNotifications } from './useMemberNotifications.js';
import { setSessionCredentials } from './api.js';

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  onopen: ((event: Event) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  closed = false;
  constructor(readonly url: string) {
    super();
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.(new Event('open'));
  }
  fail() {
    this.onerror?.(new Event('error'));
  }
  emit(type: string, data: unknown, seq = '') {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data), lastEventId: seq }));
  }
}
const userId = randomUUID();
const session = {
  user: { id: userId, username: 'zhangsan', displayName: '张三', isManagement: false },
  csrfToken: 'a'.repeat(64),
  expiresAt: '2026-11-19T00:00:00.000Z',
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  setSessionCredentials(session);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(session)));
});
afterEach(() => {
  cleanup();
  setSessionCredentials(null);
  vi.unstubAllGlobals();
});
const frame = (conversationId: string, seq: number, text = '消息', runId = randomUUID()) => ({
  id: randomUUID(),
  conversationId,
  runId,
  seq,
  createdAt: '2026-11-18T12:00:00.000Z',
  type: 'assistant_message',
  payload: { content: text },
});
it('原生流只开一次，断线保留状态和原连接，重复序号不重复消息', async () => {
  const id = randomUUID();
  const hook = renderHook(() => useConversationStream(id));
  const source = FakeEventSource.instances[0]!;
  expect(source.url).toBe(`/api/conversations/${id}/events?afterSeq=0`);
  const first = frame(id, 1);
  act(() => {
    source.open();
    source.emit(first.type, first, '1');
    source.emit(first.type, first, '1');
  });
  expect(hook.result.current.state.messages).toHaveLength(1);
  await act(async () => {
    source.fail();
  });
  expect(FakeEventSource.instances).toHaveLength(1);
  expect(hook.result.current.connection).toBe('reconnecting');
  const next = frame(id, 2);
  act(() => {
    source.open();
    source.emit(next.type, next, '2');
  });
  expect(hook.result.current.state.messages).toHaveLength(2);
  expect(hook.result.current.connection).toBe('open');
  hook.unmount();
  expect(source.closed).toBe(true);
});
it('切换对话会关闭旧流、清空正文，旧流迟到回调不能污染新对话', () => {
  const firstId = randomUUID(),
    secondId = randomUUID();
  const hook = renderHook(({ id }) => useConversationStream(id), { initialProps: { id: firstId } });
  const old = FakeEventSource.instances[0]!;
  act(() => old.emit('assistant_message', frame(firstId, 1, '旧正文'), '1'));
  hook.rerender({ id: secondId });
  expect(old.closed).toBe(true);
  expect(hook.result.current.state.messages).toEqual([]);
  act(() => old.emit('assistant_message', frame(firstId, 2, '迟到正文'), '2'));
  expect(hook.result.current.state.messages).toEqual([]);
  act(() =>
    FakeEventSource.instances[1]!.emit('assistant_message', frame(secondId, 1, '新正文'), '1'),
  );
  expect(hook.result.current.state.messages.map((m) => m.text)).toEqual(['新正文']);
});
it('序号断档立即停流，手动重连从0完整重建而非跳过', () => {
  const id = randomUUID();
  const hook = renderHook(() => useConversationStream(id));
  const source = FakeEventSource.instances[0]!;
  act(() => source.emit('assistant_message', frame(id, 2), '2'));
  expect(source.closed).toBe(true);
  expect(hook.result.current.connection).toBe('error');
  act(() => hook.result.current.reconnect());
  expect(FakeEventSource.instances[1]!.url).toContain('afterSeq=0');
  expect(hook.result.current.state.lastSeq).toBe(0);
});
it('浏览器已永久关闭的EventSource显示可恢复错误，而不永远声称重连中', async () => {
  const id = randomUUID();
  const hook = renderHook(() => useConversationStream(id));
  const source = FakeEventSource.instances[0]!;
  Object.defineProperty(source, 'readyState', { value: 2 });
  await act(async () => source.fail());
  expect(hook.result.current.connection).toBe('error');
});
it('401会关闭流并清空私有正文，不继续显示已失效账号的数据', async () => {
  const id = randomUUID();
  const hook = renderHook(() => useConversationStream(id));
  const source = FakeEventSource.instances[0]!;
  act(() => source.emit('assistant_message', frame(id, 1, '旧账号正文'), '1'));
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        json(
          { error: { code: 'LOGIN_REQUIRED', message: '请重新登录。', requestId: randomUUID() } },
          401,
        ),
      ),
  );
  await act(async () => source.fail());
  await waitFor(() => expect(hook.result.current.connection).toBe('closed'));
  expect(source.closed).toBe(true);
  expect(hook.result.current.state.messages).toEqual([]);
});
it('用户通知快照整体替换，不累加、不使用对话序号，禁用后清空', () => {
  const hook = renderHook(({ enabled }) => useMemberNotifications(enabled), {
    initialProps: { enabled: true },
  });
  const source = FakeEventSource.instances[0]!;
  const item = {
    id: randomUUID(),
    kind: 'review',
    conversationId: randomUUID(),
    projectId: null,
    createdAt: '2026-11-18T12:00:00.000Z',
  };
  act(() =>
    source.emit('pending_snapshot', {
      generatedAt: '2026-11-18T12:00:00.000Z',
      items: [item],
      truncated: false,
    }),
  );
  expect(hook.result.current.snapshot?.items).toHaveLength(1);
  act(() =>
    source.emit('pending_snapshot', {
      generatedAt: '2026-11-18T12:00:01.000Z',
      items: [],
      truncated: false,
    }),
  );
  expect(hook.result.current.snapshot?.items).toEqual([]);
  hook.rerender({ enabled: false });
  expect(source.closed).toBe(true);
  expect(hook.result.current.snapshot).toBeNull();
});
