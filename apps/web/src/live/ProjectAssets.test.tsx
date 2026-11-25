// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectFiles } from './ProjectFiles.js';
import { ProjectDocuments } from './ProjectDocuments.js';
import { setSessionCredentials } from './api.js';

const mocks = vi.hoisted(() => ({
  workspace: vi.fn(),
  workspaceVersions: vi.fn(),
  workspaceFiles: vi.fn(),
  humanRevisionSource: vi.fn(),
  humanRevisions: vi.fn(),
  saveWordRevision: vi.fn(),
  documents: vi.fn(),
  startIntake: vi.fn(),
  intakeReport: vi.fn(),
  intakeHistory: vi.fn(),
  retryIntake: vi.fn(),
  editIntakeCategory: vi.fn(),
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
  mocks.intakeHistory.mockResolvedValue({ items: [], nextCursor: null });
  mocks.humanRevisionSource.mockResolvedValue({ source: null });
  mocks.humanRevisions.mockResolvedValue({ items: [], nextCursor: null });
  mocks.saveWordRevision.mockResolvedValue({});
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

it('项目文件页关联原审核卡并用原始字节上传 Word 修改稿', async () => {
  const path = '结果/核查.docx';
  const mediaType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  mocks.workspaceFiles.mockResolvedValue({
    items: [{ path, byteSize: 42, mediaType }],
    nextCursor: null,
  });
  mocks.humanRevisionSource.mockResolvedValue({
    source: { reviewId: documentId, sourceVersionId: oldId },
  });
  mocks.saveWordRevision.mockRejectedValueOnce(new Error('合成上传响应丢失'));
  show(
    <ProjectFiles
      projectId={projectId}
      userId="member"
      onOpenFile={vi.fn()}
      onOpenDiff={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: `上传修改稿：${path}` }));
  const input = await screen.findByLabelText('修改稿（Word .docx）');
  const file = new File(['合成修改稿字节'], '修改稿.docx', { type: mediaType });
  fireEvent.change(input, { target: { files: [file] } });
  fireEvent.click(screen.getByRole('button', { name: '上传并保存新版本' }));
  fireEvent.click(await screen.findByRole('button', { name: '放弃重试' }));
  fireEvent.click(screen.getByRole('button', { name: '关闭修改稿' }));
  fireEvent.click(screen.getByRole('button', { name: `上传修改稿：${path}` }));
  const reopened = await screen.findByLabelText('修改稿（Word .docx）');
  fireEvent.change(reopened, { target: { files: [file] } });
  fireEvent.click(screen.getByRole('button', { name: '上传并保存新版本' }));
  await waitFor(() =>
    expect(mocks.saveWordRevision).toHaveBeenNthCalledWith(
      2,
      workspaceId,
      expect.objectContaining({
        reviewId: documentId,
        expectedCurrentVersionId: currentId,
        sourceVersionId: oldId,
        path,
      }),
      file,
    ),
  );
  expect(mocks.humanRevisionSource).toHaveBeenCalledTimes(2);
  expect(mocks.humanRevisionSource).toHaveBeenLastCalledWith(workspaceId, currentId, path);
  expect(mocks.saveWordRevision.mock.calls[1]![1].requestKey).not.toBe(
    mocks.saveWordRevision.mock.calls[0]![1].requestKey,
  );
});

it('从资料页提交 ZIP 并展示导入报告', async () => {
  mocks.startIntake.mockResolvedValue({ id: documentId, status: 'queued', created: true });
  mocks.intakeReport.mockResolvedValue({
    id: documentId,
    name: 'test.zip',
    status: 'complete',
    totals: { outerFiles: 1, embeddedFiles: 0, duplicates: 0, ready: 1, failed: 0 },
    categories: [{ category: 'predicate', count: 1 }],
    items: [{ path: 'predicate.pdf', category: 'predicate', sourceNames: [], duplicate: false }],
  });
  show(<ProjectDocuments projectId={projectId} userId="member" onOpenEvidence={vi.fn()} />);
  const zip = new File(['fictional'], 'test.zip', { type: 'application/zip' });
  fireEvent.change(screen.getByLabelText('选择 ZIP 资料包'), { target: { files: [zip] } });
  fireEvent.click(screen.getByRole('button', { name: '导入资料包' }));
  await screen.findByText('导入完成');
  expect(mocks.startIntake).toHaveBeenCalledWith(projectId, zip, 'internal');
  expect(mocks.intakeReport).toHaveBeenCalledWith(documentId, expect.any(AbortSignal));
  expect(screen.getByText('查看分类及资料路径')).toBeTruthy();
});

it('从项目历史打开已有报告', async () => {
  mocks.intakeHistory.mockResolvedValue({ items: [{ id: documentId, name: '之前的资料包.zip' }] });
  mocks.intakeReport.mockResolvedValue({
    id: documentId,
    name: '之前的资料包.zip',
    status: 'failed',
    canRetry: true,
    totals: { outerFiles: 0, embeddedFiles: 0, duplicates: 0, ready: 0, failed: 0 },
    categories: [],
    items: [],
  });
  show(<ProjectDocuments projectId={projectId} userId="member" onOpenEvidence={vi.fn()} />);
  await screen.findByRole('button', { name: '重试导入' });
  expect(screen.getByLabelText('导入历史')).toHaveProperty('value', documentId);
  expect(mocks.intakeReport).toHaveBeenCalledWith(documentId, expect.any(AbortSignal));
});

it('目录打包过程中会话变更时停止上传', async () => {
  let release!: (bytes: ArrayBuffer) => void;
  const content = new Promise<ArrayBuffer>((resolve) => {
    release = resolve;
  });
  const read = vi.fn(() => content);
  const item = Object.defineProperties(new File(['fixture'], 'a.pdf'), {
    webkitRelativePath: { value: 'folder/a.pdf' },
    arrayBuffer: { value: read },
  });
  show(<ProjectDocuments projectId={projectId} userId="member" onOpenEvidence={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('选择资料目录'), { target: { files: [item] } });
  fireEvent.click(screen.getByRole('button', { name: '导入资料包' }));
  await waitFor(() => expect(read).toHaveBeenCalled());
  setSessionCredentials(null);
  release(new ArrayBuffer(1));
  await screen.findByText(/登录会话已变更/);
  expect(mocks.startIntake).not.toHaveBeenCalled();
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
  expect(screen.getByLabelText('选择 ZIP 资料包')).toBeTruthy();
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

it('兼容旧接口的已解析状态，并识别新接口明确报告的无可读页', async () => {
  const onOpenEvidence = vi.fn();
  const common = {
    sourceKey: 'RAW-READY',
    dataLevel: 'internal',
    currentVersion: 3,
    parseState: 'ready',
  };
  mocks.documents.mockResolvedValue({
    items: [
      { ...common, id: documentId, name: '旧接口资料' },
      { ...common, id: workspaceId, name: '暂无正文资料', readablePage: null },
    ],
    hasMore: false,
    nextCursor: null,
  });
  show(<ProjectDocuments projectId={projectId} userId="member" onOpenEvidence={onOpenEvidence} />);
  fireEvent.click(await screen.findByRole('button', { name: '打开资料：旧接口资料' }));
  expect(onOpenEvidence).toHaveBeenCalledWith([{ documentId, version: 3, page: 1 }]);
  expect(
    (screen.getByRole('button', { name: '打开资料：暂无正文资料' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
