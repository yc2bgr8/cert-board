// @vitest-environment jsdom
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { api, ApiError } from './api.js';
import { EvidencePanel } from './EvidencePanel.js';
import { FilePanel } from './FilePanel.js';
import { DiffPanel } from './DiffPanel.js';
import { exactQuoteParts, joinTextPages } from './text-pages.js';

const projectId = randomUUID(),
  workspaceId = randomUUID(),
  versionId = randomUUID(),
  documentId = randomUUID(),
  from = randomUUID();
const path = '交付/核对报告.md';
const stamp = '2026-11-18T12:00:00.000Z';
const clients: QueryClient[] = [];
const target = { projectId, versionId, path };
function view(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function docPage(
  text: string,
  whole = text,
  offset = 0,
  page = 1,
  locatorKind: 'physical_page' | 'extraction_unit' = 'physical_page',
) {
  const end = offset + text.length;
  return {
    documentId,
    sourceKey: 'D035',
    name: '虚构资料',
    version: 1,
    page,
    locatorKind,
    dataLevel: 'internal' as const,
    text,
    method: 'text' as const,
    ocrScore: null,
    isPlaceholder: false as const,
    warning: null,
    offset,
    totalCharacters: whole.length,
    truncated: end < whole.length,
    nextOffset: end < whole.length ? end : null,
    contentSha256: 'a'.repeat(64),
    originalSha256: null,
  };
}
function filePage(text: string, whole = text, offset = 0) {
  const end = offset + text.length;
  return {
    path,
    sha256: digest(whole),
    byteSize: Buffer.byteLength(whole),
    dataLevel: 'internal' as const,
    mediaType: 'text/markdown',
    workspaceId,
    versionId,
    draftId: null,
    text,
    offset,
    totalCharacters: whole.length,
    truncated: end < whole.length,
    nextOffset: end < whole.length ? end : null,
  };
}
beforeEach(() => {
  vi.spyOn(api, 'workspace').mockResolvedValue({
    id: workspaceId,
    projectId,
    currentVersionId: versionId,
    dataLevel: 'internal',
    version: 1,
    createdAt: stamp,
    updatedAt: stamp,
  });
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('字符分页严格连续，保留Unicode原文，不拼接缺口或重复页', () => {
  const whole = '甲😀乙\n原文';
  const pages = [filePage('甲😀', whole), filePage('乙\n原文', whole, 3)];
  expect(joinTextPages(pages)).toEqual({
    text: whole,
    complete: true,
    totalCharacters: whole.length,
  });
  expect(() => joinTextPages([pages[0]!, { ...pages[1]!, offset: 2 }])).toThrow();
  expect(() => joinTextPages([pages[0]!, pages[0]!])).toThrow();
  expect(exactQuoteParts('K123456 k123456', 'k123456')?.before).toBe('K123456 ');
  expect(exactQuoteParts('K 123456', 'K123456')).toBeNull();
});
it('证据按实际nextOffset续读，跨片段的完整引用才高亮，HTML保持普通文本', async () => {
  const whole = '编号 K123456\n<img src="https://external.invalid/a">';
  const chunk = '编号 K12';
  const read = vi
    .spyOn(api, 'documentPage')
    .mockImplementation(async (_id, _version, page, options) =>
      options?.offset
        ? docPage(whole.slice(chunk.length), whole, chunk.length, page)
        : docPage(chunk, whole, 0, page),
    );
  view(<EvidencePanel sources={[{ documentId, version: 1, page: 1, quote: 'K123456' }]} />);
  await screen.findByText('当前片段尚未覆盖逐字一致的引用，请继续读取核对。');
  expect(document.querySelector('mark')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '继续读取原文' }));
  await waitFor(() => expect(document.querySelector('mark')?.textContent).toBe('K123456'));
  expect(read.mock.calls[1]?.[3]?.offset).toBe(chunk.length);
  expect(screen.getByRole('region', { name: 'D035 第 1 页原文' })).toBeTruthy();
  expect(document.querySelector('img')).toBeNull();
  expect(screen.getByLabelText('D035解析原文').textContent).toBe(whole);
});
it('两来源并排且DOCX标提取单元，不拿不同页或版本替换引用', async () => {
  vi.spyOn(api, 'documentPage').mockImplementation(async (_id, _version, page) =>
    docPage(
      page === 1 ? '第一处' : '第二处',
      page === 1 ? '第一处' : '第二处',
      0,
      page,
      page === 1 ? 'extraction_unit' : 'physical_page',
    ),
  );
  const rendered = view(
    <EvidencePanel
      sources={[
        { documentId, version: 1, page: 1, quote: '第一处' },
        { documentId, version: 1, page: 2, quote: '第二处' },
      ]}
    />,
  );
  await screen.findByRole('region', { name: 'D035 第 1 提取单元原文' });
  await screen.findByRole('region', { name: 'D035 第 2 页原文' });
  expect(
    rendered.container.querySelectorAll('.review-evidence-grid.is-comparison > section'),
  ).toHaveLength(2);
  expect(Array.from(document.querySelectorAll('mark')).map((mark) => mark.textContent)).toEqual([
    '第一处',
    '第二处',
  ]);
});
it('占位或作废资料错误保持可见，不伪造原页；错误来源响应不展示为当前引用', async () => {
  const read = vi
    .spyOn(api, 'documentPage')
    .mockRejectedValueOnce(
      new ApiError(422, 'DOCUMENT_PLACEHOLDER', '该页只是占位页，不能作为原文。'),
    )
    .mockResolvedValue({ ...docPage('不应显示'), documentId: randomUUID() });
  view(<EvidencePanel sources={[{ documentId, version: 1, page: 1, quote: '需要核对' }]} />);
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toContain('占位页');
  fireEvent.click(screen.getByRole('button', { name: '重新读取原文' }));
  await waitFor(() => expect(read.mock.calls).toHaveLength(2));
  await screen.findByText('资料定位或续读内容不一致，请重新加载当前引用。', { exact: false });
  expect(screen.queryByText('不应显示')).toBeNull();
});
it('文件部分内容不能下载，完整续读后核验哈希与字节数并下载文本', async () => {
  const whole = '# 报告\n甲😀乙';
  const chunk = '# 报告\n';
  vi.spyOn(api, 'workspaceFile').mockImplementation(async (_id, _path, options) =>
    options?.offset
      ? filePage(whole.slice(chunk.length), whole, chunk.length)
      : filePage(chunk, whole),
  );
  const create = vi.fn(() => 'blob:local-fixture');
  const revoke = vi.fn();
  const OriginalURL = URL;
  vi.stubGlobal(
    'URL',
    class extends OriginalURL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    },
  );
  vi.stubGlobal('crypto', webcrypto);
  const downloaded: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloaded.push(this.download);
  });
  view(<FilePanel target={target} />);
  const download = await screen.findByRole<HTMLButtonElement>('button', { name: '下载完整文本' });
  expect(download.disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '继续读取文件' }));
  await waitFor(() => expect(download.disabled).toBe(false));
  fireEvent.click(download);
  await waitFor(() => expect(create.mock.calls).toHaveLength(1));
  expect(downloaded).toEqual(['核对报告.md']);
});
it('文件哈希不一致时不生成下载地址', async () => {
  vi.spyOn(api, 'workspaceFile').mockResolvedValue({
    ...filePage('虚构文本'),
    sha256: 'f'.repeat(64),
  });
  const create = vi.fn();
  const OriginalURL = URL;
  vi.stubGlobal(
    'URL',
    class extends OriginalURL {
      static createObjectURL = create;
      static revokeObjectURL = vi.fn();
    },
  );
  vi.stubGlobal('crypto', webcrypto);
  view(<FilePanel target={target} />);
  fireEvent.click(await screen.findByRole('button', { name: '下载完整文本' }));
  await screen.findByText('文件完整性未能确认，未下载。请重新读取完整文本后重试。');
  expect(create.mock.calls).toHaveLength(0);
});
it('文件变化进入文本对比，按行游标续读，打开文件保留版本和路径', async () => {
  const line = (text: string, index: number) => ({
    kind: 'added' as const,
    oldLine: null,
    newLine: index,
    text,
    ending: '\n' as const,
    lineTruncated: false,
  });
  const diff = vi.spyOn(api, 'workspaceDiff').mockImplementation(async (_id, options) =>
    options.path
      ? {
          kind: 'text',
          path,
          beforeSha256: null,
          afterSha256: 'a'.repeat(64),
          diff: {
            available: true,
            lines: [line(options.offset ? '第二行' : '新增范围', options.offset ? 2 : 1)],
            added: 2,
            removed: 0,
            totalLines: 2,
            offset: options.offset ?? 0,
            hasMore: !options.offset,
            nextOffset: options.offset ? null : 1,
            warning: null,
          },
        }
      : {
          kind: 'files',
          changes: [
            {
              path,
              change: 'added',
              before: null,
              after: {
                path,
                sha256: 'a'.repeat(64),
                byteSize: 20,
                dataLevel: 'internal',
                mediaType: 'text/markdown',
              },
            },
          ],
          hasMore: false,
          nextCursor: null,
        },
  );
  const open = vi.fn();
  view(<DiffPanel target={{ projectId, from, to: versionId }} onOpenFile={open} />);
  fireEvent.click(await screen.findByRole('button', { name: `查看文本对比：${path}` }));
  await screen.findByRole('region', { name: '文本差异' });
  expect(document.querySelector('[data-change="added"]')?.textContent).toContain('新增范围');
  fireEvent.click(screen.getByRole('button', { name: '继续读取差异' }));
  await screen.findByText('第二行', { exact: false });
  expect(diff.mock.calls.at(-1)?.[1]?.offset).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: '打开较新版本文件' }));
  expect(open).toHaveBeenCalledWith(target);
});
it('二进制或超限差异只显示真实限制，不能假称没有变化', async () => {
  vi.spyOn(api, 'workspaceDiff').mockResolvedValue({
    kind: 'binary',
    path,
    beforeSha256: 'a'.repeat(64),
    afterSha256: 'b'.repeat(64),
    warning: '当前只提供哈希变化，原始版面尚未接入。',
  });
  view(
    <DiffPanel target={{ projectId, from, to: versionId, path }} onOpenFile={() => undefined} />,
  );
  await screen.findByText('当前只提供哈希变化，原始版面尚未接入。', { exact: false });
  expect(screen.getByRole('status').textContent).toContain('只提供哈希变化');
  expect(screen.queryByText('两个版本没有文件变化。')).toBeNull();
});
