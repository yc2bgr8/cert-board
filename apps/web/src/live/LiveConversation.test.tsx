// @vitest-environment jsdom
import { randomUUID } from 'node:crypto';
import { useState } from 'react';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LiveConversation } from './LiveConversation.js';
import { api, type ConversationDetail } from './api.js';
import { initialConversationState, type LiveRun } from './events.js';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function conversationDetail(
  conversationId: string,
  currentRunId: string | null,
): ConversationDetail {
  const now = new Date().toISOString();
  return {
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
    currentRunId,
    lastMessageSeq: 1,
    lastEventSeq: 1,
    createdAt: now,
    updatedAt: now,
    canWrite: true,
  };
}

it('断流时保留发起人的停止操作，暂停用旧记录发送插话', async () => {
  const conversationId = randomUUID();
  const runId = randomUUID();
  const detail = conversationDetail(conversationId, runId);
  const now = detail.createdAt;
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
  const stream = {
    state: {
      ...initialConversationState(conversationId),
      currentRunId: runId,
      runs: { [runId]: run },
      runOrder: [runId],
      lastSeq: 1,
    },
    connection: 'reconnecting' as const,
    error: '连接暂时中断',
    reconnect: vi.fn(),
  };
  function TestConversation() {
    const [text, setText] = useState('');
    return (
      <LiveConversation
        conversationId={conversationId}
        stream={stream}
        text={text}
        setText={setText}
      />
    );
  }
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TestConversation />
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

it('提案首屏读取期间收到通知会补刷，补刷时暂停分页按钮', async () => {
  const conversationId = randomUUID();
  const proposalId = randomUUID();
  const detail = conversationDetail(conversationId, null);
  type ProposalPage = Awaited<ReturnType<typeof api.conversationProposals>>;
  let finishFirst!: (page: ProposalPage) => void;
  let finishRefresh!: (page: ProposalPage) => void;
  const first = new Promise<ProposalPage>((resolve) => {
    finishFirst = resolve;
  });
  const refresh = new Promise<ProposalPage>((resolve) => {
    finishRefresh = resolve;
  });
  vi.spyOn(api, 'conversation').mockResolvedValue(detail);
  const load = vi
    .spyOn(api, 'conversationProposals')
    .mockReturnValueOnce(first)
    .mockReturnValueOnce(refresh);
  const client = new QueryClient({ defaultOptions: { queries: { refetchOnReconnect: false } } });
  const stream = {
    state: { ...initialConversationState(conversationId), lastSeq: 1 },
    connection: 'open' as const,
    error: null,
    reconnect: vi.fn(),
  };
  const openProposal = vi.fn();
  const setText = vi.fn();
  const view = (proposalNoticeKey: string) => (
    <QueryClientProvider client={client}>
      <LiveConversation
        conversationId={conversationId}
        stream={stream}
        text=""
        setText={setText}
        onProposal={openProposal}
        proposalNoticeKey={proposalNoticeKey}
      />
    </QueryClientProvider>
  );
  const rendered = render(view(proposalId));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  // 首次请求已读到待批准状态，随后待办因他人决定移除该条。
  rendered.rerender(view(''));
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () =>
    finishFirst({
      items: [{ id: proposalId, status: 'proposed' }],
      hasMore: true,
      nextCursor: proposalId,
    }),
  );
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '继续读取提案' }).disabled).toBe(
    true,
  );
  await act(async () =>
    finishRefresh({
      items: [{ id: proposalId, status: 'rejected' }],
      hasMore: true,
      nextCursor: proposalId,
    }),
  );
  await screen.findByText('外发提案 · 已拒绝');
  fireEvent.click(screen.getByRole('button', { name: '查看提案' }));
  expect(openProposal).toHaveBeenCalledWith(proposalId);

  const lastPage = { items: [], hasMore: false, nextCursor: null };
  load
    .mockResolvedValueOnce(lastPage)
    .mockResolvedValueOnce({
      items: [{ id: proposalId, status: 'approved' }],
      hasMore: true,
      nextCursor: proposalId,
    })
    .mockResolvedValueOnce(lastPage);
  try {
    act(() => onlineManager.setOnline(false));
    const nextPage = screen.getByRole<HTMLButtonElement>('button', { name: '继续读取提案' });
    fireEvent.click(nextPage);
    await waitFor(() => expect(nextPage.disabled).toBe(true));
    rendered.rerender(view(proposalId));
    expect(load).toHaveBeenCalledTimes(2);
    act(() => onlineManager.setOnline(true));
    await screen.findByText('外发提案 · 已批准，等待本地测试');
    expect(load).toHaveBeenCalledTimes(5);
  } finally {
    act(() => onlineManager.setOnline(true));
  }
});
