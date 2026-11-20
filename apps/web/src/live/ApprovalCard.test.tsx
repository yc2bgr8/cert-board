// @vitest-environment jsdom
import { randomUUID } from 'node:crypto';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from './api.js';
import { ApprovalCard, useBrowserCommand } from './ApprovalCard.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('响应不明后只在重新点击时用原请求编号确认，成功后同一内容可作为新操作', async () => {
  const execute = vi
    .fn<(key: string) => Promise<string>>()
    .mockRejectedValueOnce(new ApiError(0, 'NETWORK_UNAVAILABLE', '连接已中断'))
    .mockResolvedValue('完成');
  const hook = renderHook(() => useBrowserCommand());
  await act(async () => {
    await hook.result.current.run(['message', '核对资料'], execute);
  });
  expect(hook.result.current.error).toBe('连接已中断（错误编号 NETWORK_UNAVAILABLE）');
  expect(execute).toHaveBeenCalledTimes(1);
  await act(async () => {
    await hook.result.current.run(['message', '核对资料'], execute);
  });
  await act(async () => {
    await hook.result.current.run(['message', '核对资料'], execute);
  });
  expect(execute.mock.calls[0]?.[0]).toBe(execute.mock.calls[1]?.[0]);
  expect(execute.mock.calls[1]?.[0]).not.toBe(execute.mock.calls[2]?.[0]);
});

it('批准预览过期时只刷新内容，重新点击后才用新版本提交', async () => {
  const approvalId = randomUUID();
  const preview = {
    id: approvalId,
    conversationId: randomUUID(),
    runId: randomUUID(),
    toolName: 'queue_internal_message',
    toolVersion: '1',
    version: 1,
    contentHash: 'a'.repeat(64),
    status: 'pending' as const,
    dataLevel: 'internal' as const,
    preview: {
      summary: '登记测试提醒',
      changes: [],
      message: {
        contactId: randomUUID(),
        recipientName: '测试同事',
        subject: '核查提醒',
        body: '请核对旧内容',
      },
    },
    createdAt: '2026-11-18T09:00:00Z',
    decidedAt: null,
  };
  vi.spyOn(api, 'approval')
    .mockResolvedValueOnce(preview)
    .mockResolvedValue({
      ...preview,
      version: 2,
      contentHash: 'b'.repeat(64),
      preview: {
        ...preview.preview,
        message: { ...preview.preview.message, body: '请核对新内容' },
      },
    });
  const decide = vi
    .spyOn(api, 'decideApproval')
    .mockRejectedValueOnce(new ApiError(409, 'VERSION_CONFLICT', '预览已更新，请再次确认'))
    .mockResolvedValue({
      approvalId,
      decisionId: randomUUID(),
      continuationId: null,
      status: 'approved',
      executed: false,
      replayed: false,
      version: 3,
    });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ApprovalCard approvalId={approvalId} disabled={false} />
    </QueryClientProvider>,
  );
  await screen.findByText('请核对旧内容');
  fireEvent.click(screen.getByRole('button', { name: '允许' }));
  await screen.findByText('请核对新内容');
  expect(decide).toHaveBeenCalledTimes(1);
  const allow = screen.getByRole<HTMLButtonElement>('button', { name: '允许' });
  await waitFor(() => expect(allow.disabled).toBe(false));
  fireEvent.click(allow);
  await screen.findByText('已允许');
  expect(decide).toHaveBeenNthCalledWith(
    1,
    approvalId,
    expect.objectContaining({
      action: 'allow_once',
      expectedVersion: 1,
      expectedContentHash: 'a'.repeat(64),
    }),
  );
  expect(decide).toHaveBeenNthCalledWith(
    2,
    approvalId,
    expect.objectContaining({
      action: 'allow_once',
      expectedVersion: 2,
      expectedContentHash: 'b'.repeat(64),
    }),
  );
});
