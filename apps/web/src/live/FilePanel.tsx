import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, errorMessage } from './api.js';
import { SafeMarkdown } from '../SafeMarkdown.js';
import type { WorkspaceFileTarget } from './review-navigation.js';
import { joinTextPages } from './text-pages.js';
import './review-panels.css';

export function FilePanel({ target }: { target: WorkspaceFileTarget }) {
  return <FileContent key={JSON.stringify(target)} target={target} />;
}
function FileContent({ target }: { target: WorkspaceFileTarget }) {
  const workspace = useQuery({
    queryKey: ['live', 'workspace', target.projectId],
    queryFn: ({ signal }) => api.workspace(target.projectId, signal),
    retry: false,
  });
  const files = useInfiniteQuery({
    queryKey: ['live', 'file-content', workspace.data?.id, target.versionId, target.path],
    enabled: !!workspace.data,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      api.workspaceFile(
        workspace.data!.id,
        target.path,
        { versionId: target.versionId, offset: pageParam, limit: 8000 },
        signal,
      ),
    getNextPageParam: (last) => (last.truncated ? (last.nextOffset ?? undefined) : undefined),
    retry: false,
  });
  const [downloadError, setDownloadError] = useState<string | null>(null),
    [downloading, setDownloading] = useState(false);
  const pages = files.data?.pages ?? [],
    first = pages[0];
  let combined: ReturnType<typeof joinTextPages> | undefined,
    failure: string | null = null;
  try {
    if (
      pages.some(
        (page) =>
          page.versionId !== target.versionId ||
          page.path !== target.path.normalize('NFC') ||
          page.sha256 !== first?.sha256 ||
          page.workspaceId !== workspace.data?.id,
      )
    )
      throw new Error('file_mismatch');
    combined = joinTextPages(pages);
  } catch {
    failure = '文件版本或续读位置不一致，请重新加载，未生成下载文件。';
  }
  async function download() {
    if (!first || !combined?.complete || failure || downloading) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const bytes = new TextEncoder().encode(combined.text);
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
      if (hash !== first.sha256 || bytes.byteLength !== first.byteSize)
        throw new Error('file_hash');
      const url = URL.createObjectURL(new Blob([bytes], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = target.path.split('/').at(-1) ?? '文本文件.txt';
      document.body.append(link);
      link.click();
      link.remove();
      const revoke = URL.revokeObjectURL.bind(URL);
      setTimeout(() => revoke(url), 1000);
    } catch {
      setDownloadError('文件完整性未能确认，未下载。请重新读取完整文本后重试。');
    } finally {
      setDownloading(false);
    }
  }
  return (
    <section className="review-file-panel" aria-label="工作区文件">
      <h3 className="review-panel-path">{target.path}</h3>
      <p className="review-panel-meta">
        已保存的工作区版本 <code>{target.versionId}</code>
      </p>
      <p className="review-panel-note">当前展示已保存的文本。PDF 和 Office 版面预览待接入。</p>
      {(workspace.isPending || (workspace.data && files.isPending)) && (
        <p role="status">正在读取文件…</p>
      )}
      {(workspace.isError || files.isError || failure) && (
        <p className="review-panel-error" role="alert">
          {failure ?? errorMessage(workspace.error ?? files.error)}{' '}
          <button
            type="button"
            onClick={() => void (workspace.isError ? workspace.refetch() : files.refetch())}
          >
            重新读取文件
          </button>
        </p>
      )}
      {first && combined && !failure && (
        <>
          <div className="review-file-text">
            {first.mediaType.split(';', 1)[0]?.trim().toLowerCase() === 'text/markdown' ? (
              <SafeMarkdown workbench>{combined.text}</SafeMarkdown>
            ) : (
              <pre>{combined.text || '此文本文件为空。'}</pre>
            )}
          </div>
          <p className="review-panel-meta">
            已读取 {combined.text.length} / {combined.totalCharacters} 个字符
          </p>
          {files.hasNextPage && (
            <button
              className="review-panel-more"
              type="button"
              disabled={files.isFetchingNextPage}
              onClick={() => void files.fetchNextPage()}
            >
              {files.isFetchingNextPage ? '正在续读…' : '继续读取文件'}
            </button>
          )}
          <button
            className="review-panel-more"
            type="button"
            disabled={!combined.complete || downloading}
            onClick={() => void download()}
          >
            {downloading ? '正在核对下载…' : '下载完整文本'}
          </button>
          {!combined.complete && (
            <p className="review-panel-note">
              继续读取全部内容后才能下载，避免把部分内容保存为完整文件。
            </p>
          )}
        </>
      )}
      {downloadError && (
        <p className="review-panel-error" role="alert">
          {downloadError}
        </p>
      )}
    </section>
  );
}
