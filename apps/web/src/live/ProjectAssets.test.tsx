// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectFiles } from './ProjectFiles.js';
import { ProjectDocuments } from './ProjectDocuments.js';

const mocks = vi.hoisted(() => ({
  workspace: vi.fn(),
  workspaceVersions: vi.fn(),
  workspaceFiles: vi.fn(),
  documents: vi.fn(),
}));
vi.mock('./api.js', async (original) => {
  const actual = await original<typeof import('./api.js')>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});
const projectId = '10000000-0000-4000-8000-000000000001';
const workspaceId = '10000000-0000-4000-8000-000000000002';
const oldId = '10000000-0000-4000-8000-000000000003';
const currentId = '10000000-0000-4000-8000-000000000004';
const documentId = '10000000-0000-4000-8000-000000000005';
const clients: QueryClient[] = [];
function show(content: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}>{content}</QueryClientProvider>);
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspace.mockResolvedValue({ id: workspaceId, currentVersionId: currentId });
  mocks.workspaceVersions.mockResolvedValue({
    items: [
      { id: oldId, number: 1, summary: '初始版本' },
      { id: currentId, number: 2, summary: '实际保存的改动' },
    ],
    hasMore: false,
    nextAfterNumber: null,
  });
  mocks.workspaceFiles.mockResolvedValue({
    items: [{ path: '结果/核查.md', byteSize: 25, mediaType: 'text/markdown' }],
    hasMore: false,
    nextCursor: null,
  });
  mocks.documents.mockResolvedValue({
    items: [
      {
        id: documentId,
        name: '申报摘要',
        sourceKey: 'D035',
        currentVersion: 3,
        dataLevel: 'internal',
      },
    ],
    hasMore: false,
    nextCursor: null,
  });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

it('文件固定实际版本读取，续页保留路径游标，历史版本变化不会混入旧文件', async () => {
  const onOpenFile = vi.fn(),
    onOpenDiff = vi.fn();
  mocks.workspaceFiles.mockImplementation(
    async (_id, options: { cursor?: string; versionId: string }) =>
      options.versionId === oldId
        ? {
            items: [{ path: '初版.md', byteSize: 10, mediaType: 'text/markdown' }],
            hasMore: false,
            nextCursor: null,
          }
        : options.cursor
          ? {
              items: [{ path: '结果/补充.md', byteSize: 5, mediaType: 'text/markdown' }],
              hasMore: false,
              nextCursor: null,
            }
          : {
              items: [{ path: '结果/核查.md', byteSize: 25, mediaType: 'text/markdown' }],
              hasMore: true,
              nextCursor: '结果/核查.md',
            },
  );
  show(
    <ProjectFiles
      projectId={projectId}
      userId="member"
      onOpenFile={onOpenFile}
      onOpenDiff={onOpenDiff}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: '查看文件：结果/核查.md' }));
  expect(onOpenFile).toHaveBeenCalledWith({
    projectId,
    versionId: currentId,
    path: '结果/核查.md',
  });
  fireEvent.click(screen.getByRole('button', { name: '加载更多文件' }));
  await screen.findByRole('button', { name: '查看文件：结果/补充.md' });
  expect(mocks.workspaceFiles).toHaveBeenCalledWith(
    workspaceId,
    { versionId: currentId, limit: 50, cursor: '结果/核查.md' },
    expect.any(AbortSignal),
  );
  fireEvent.change(screen.getByRole('combobox', { name: '对比起点' }), {
    target: { value: oldId },
  });
  fireEvent.click(screen.getByRole('button', { name: '查看版本对比' }));
  expect(onOpenDiff).toHaveBeenCalledWith({ projectId, from: oldId, to: currentId });
  fireEvent.change(screen.getByRole('combobox', { name: '文件版本' }), {
    target: { value: oldId },
  });
  await screen.findByRole('button', { name: '查看文件：初版.md' });
  expect(screen.queryByRole('button', { name: '查看文件：结果/补充.md' })).toBeNull();
  expect((screen.getByRole('button', { name: '查看版本对比' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

it('当前版本尚不在首批历史时仍可读当前文件，版本按实际nextAfterNumber加载', async () => {
  mocks.workspaceVersions.mockImplementation(async (_id, options: { afterNumber: number }) =>
    options.afterNumber
      ? {
          items: [{ id: currentId, number: 21, summary: '当前保存' }],
          hasMore: false,
          nextAfterNumber: null,
        }
      : { items: [{ id: oldId, number: 1, summary: '初始' }], hasMore: true, nextAfterNumber: 20 },
  );
  show(
    <ProjectFiles
      projectId={projectId}
      userId="member"
      onOpenFile={vi.fn()}
      onOpenDiff={vi.fn()}
    />,
  );
  await screen.findByRole('button', { name: '查看文件：结果/核查.md' });
  expect((screen.getByRole('combobox', { name: '文件版本' }) as HTMLSelectElement).value).toBe(
    currentId,
  );
  fireEvent.click(screen.getByRole('button', { name: '加载更多历史版本' }));
  await screen.findByRole('option', { name: '第 21 版（当前）' });
  expect(mocks.workspaceVersions).toHaveBeenCalledWith(
    workspaceId,
    { afterNumber: 20, limit: 20 },
    expect.any(AbortSignal),
  );
});

it('资料按项目和游标分页，打开确切资料版本，不补造原页和解析状态', async () => {
  const onOpenEvidence = vi.fn();
  mocks.documents.mockImplementation(async (_id, options: { cursor?: string }) =>
    options.cursor
      ? {
          items: [
            {
              id: oldId,
              name: '第二份资料',
              sourceKey: 'D002',
              currentVersion: 2,
              dataLevel: 'internal',
            },
          ],
          hasMore: false,
          nextCursor: null,
        }
      : {
          items: [
            {
              id: documentId,
              name: '申报摘要',
              sourceKey: 'D035',
              currentVersion: 3,
              dataLevel: 'internal',
            },
          ],
          hasMore: true,
          nextCursor: documentId,
        },
  );
  show(<ProjectDocuments projectId={projectId} userId="member" onOpenEvidence={onOpenEvidence} />);
  fireEvent.click(await screen.findByRole('button', { name: '打开资料：申报摘要' }));
  expect(onOpenEvidence).toHaveBeenCalledWith([{ documentId, version: 3, page: 1 }]);
  fireEvent.click(screen.getByRole('button', { name: '加载更多资料' }));
  await screen.findByRole('button', { name: '打开资料：第二份资料' });
  expect(mocks.documents).toHaveBeenCalledWith(
    projectId,
    { cursor: documentId, limit: 50 },
    expect.any(AbortSignal),
  );
  expect(screen.queryByText('解析成功')).toBeNull();
  expect(screen.getByText(/原文件预览与上传暂未开放/)).toBeTruthy();
});

it('读取失败显示重试而非空资料，重新加载使用同一项目', async () => {
  mocks.documents
    .mockRejectedValueOnce(new Error('synthetic'))
    .mockResolvedValueOnce({ items: [], hasMore: false, nextCursor: null });
  show(<ProjectDocuments projectId={projectId} userId="member" onOpenEvidence={vi.fn()} />);
  await screen.findByRole('alert');
  expect(screen.queryByText('这个项目还没有可查看的资料。')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '重新加载资料' }));
  await waitFor(() => expect(screen.getByText('这个项目还没有可查看的资料。')).toBeTruthy());
  expect(mocks.documents).toHaveBeenCalledTimes(2);
});

it('资料解析期间轮询进度，完成后才打开新版本的原文', async () => {
  const onOpenEvidence = vi.fn();
  const document = {
    id: documentId,
    name: '合成解析资料',
    sourceKey: 'RAW-01',
    currentVersion: 1,
    dataLevel: 'internal',
  };
  mocks.documents
    .mockResolvedValueOnce({
      items: [{ ...document, parseState: 'running' }],
      hasMore: false,
      nextCursor: null,
    })
    .mockResolvedValue({
      items: [{ ...document, parseState: 'ready', readablePage: { version: 1, page: 1 } }],
      hasMore: false,
      nextCursor: null,
    });
  show(<ProjectDocuments projectId={projectId} userId="member" onOpenEvidence={onOpenEvidence} />);
  const row = (await screen.findByRole('button', {
    name: '打开资料：合成解析资料',
  })) as HTMLButtonElement;
  expect(row.disabled).toBe(true);
  expect(row.textContent).toContain('解析中');
  await screen.findByText('已解析', {}, { timeout: 4_000 });
  expect(row.disabled).toBe(false);
  fireEvent.click(row);
  expect(onOpenEvidence).toHaveBeenCalledWith([{ documentId, version: 1, page: 1 }]);
});

it('新版排队时，资料库仍可打开上一可读版本的实际页码', async () => {
  const onOpenEvidence = vi.fn();
  mocks.documents.mockResolvedValue({
    items: [
      {
        id: documentId,
        name: '新版文件',
        sourceKey: 'RAW-RUN',
        dataLevel: 'internal',
        currentVersion: 3,
        parseState: 'queued',
        readablePage: { version: 2, page: 4 },
      },
    ],
    hasMore: false,
    nextCursor: null,
  });
  show(<ProjectDocuments projectId={projectId} userId="member" onOpenEvidence={onOpenEvidence} />);
  fireEvent.click(await screen.findByRole('button', { name: '打开资料：新版文件' }));
  expect(screen.getByText(/可查看第 2 版/)).toBeTruthy();
  expect(onOpenEvidence).toHaveBeenCalledWith([{ documentId, version: 2, page: 4 }]);
});
