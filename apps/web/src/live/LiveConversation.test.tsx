// @vitest-environment jsdom
import { randomUUID } from 'node:crypto';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LiveConversation } from './LiveConversation.js';
import { api, type ConversationDetail } from './api.js';
import { initialConversationState, type LiveRun } from './events.js';
import { useConversationStream } from './useConversationStream.js';

vi.mock('./useConversationStream.js', () => ({ useConversationStream: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('断流时保留发起人的停止操作，暂停用旧记录发送插话', async () => {
  const conversationId = randomUUID();
  const runId = randomUUID();
  const now = new Date().toISOString();
  const detail: ConversationDetail = {
    id: conversationId,
    projectId: randomUUID(),
    goalId: randomUUID(),
    userId: randomUUID(),
    ownerName: '张三',
    title: '核对写法',
    agentCode: 'registration',
    permissionMode: 'ask',
    status: 'active',
    maxDataLevel: 'internal',
    version: 1,
    permissionVersion: 1,
    currentRunId: runId,
    lastMessageSeq: 1,
    lastEventSeq: 1,
    createdAt: now,
    updatedAt: now,
    canWrite: true,
  };
  const run: LiveRun = {
    id: runId,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    summary: '正在核对资料',
    tools: [],
    plan: null,
    approvalId: null,
    question: null,
    reviewId: null,
    pendingSteeringCount: 0,
    workspaceChange: null,
  };
  vi.spyOn(api, 'conversation').mockResolvedValue(detail);
  const stop = vi.spyOn(api, 'stop').mockResolvedValue({
    conversationId,
    runId,
    stopped: true,
    replayed: false,
  });
  vi.mocked(useConversationStream).mockReturnValue({
    state: {
      ...initialConversationState(conversationId),
      currentRunId: runId,
      runs: { [runId]: run },
      runOrder: [runId],
      lastSeq: 1,
    },
    connection: 'reconnecting',
    error: '连接暂时中断',
    reconnect: vi.fn(),
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <LiveConversation conversationId={conversationId} />
    </QueryClientProvider>,
  );
  const stopButton = await screen.findByRole<HTMLButtonElement>('button', { name: '停止' });
  fireEvent.change(screen.getByRole('textbox', { name: '消息' }), {
    target: { value: '补充范围' },
  });
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '插话' }).disabled).toBe(true);
  expect(stopButton.disabled).toBe(false);
  fireEvent.click(stopButton);
  await waitFor(() =>
    expect(stop).toHaveBeenCalledWith(conversationId, {
      runId,
      requestKey: expect.any(String),
    }),
  );
  await screen.findByText('已收到停止回执，正在同步执行记录。');
});
