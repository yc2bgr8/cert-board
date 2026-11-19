import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, errorMessage } from './api.js';
import type { WorkspaceDiffTarget, WorkspaceFileTarget } from './review-navigation.js';
import { displayTime } from './WorkspacePages.js';

export function ProjectFiles({
  projectId,
  userId,
  onOpenFile,
  onOpenDiff,
}: {
  projectId: string;
  userId: string;
  onOpenFile(target: WorkspaceFileTarget): void;
  onOpenDiff(target: WorkspaceDiffTarget): void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const workspace = useQuery({
    queryKey: ['live', 'workspace', userId, projectId],
    queryFn: ({ signal }) => api.workspace(projectId, signal),
    retry: false,
  });
  const workspaceId = workspace.data?.id;
  const versionId = selected ?? workspace.data?.currentVersionId;
  const versions = useInfiniteQuery({
    queryKey: ['live', 'workspace-versions', userId, workspaceId],
    queryFn: ({ pageParam, signal }) =>
      api.workspaceVersions(workspaceId!, { afterNumber: pageParam, limit: 20 }, signal),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextAfterNumber ?? undefined,
    enabled: Boolean(workspaceId),
    retry: false,
  });
  const files = useInfiniteQuery({
    queryKey: ['live', 'workspace-files', userId, workspaceId, versionId],
    queryFn: ({ pageParam, signal }) =>
      api.workspaceFiles(
        workspaceId!,
        {
          versionId: versionId!,
          limit: 50,
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(workspaceId && versionId),
    retry: false,
  });
  const history = versions.data?.pages.flatMap((page) => page.items) ?? [];
  const currentInHistory = history.some((item) => item.id === workspace.data?.currentVersionId);
  const items = files.data?.pages.flatMap((page) => page.items) ?? [];
  const selectedVersion = history.find((item) => item.id === versionId);
  return (
    <section className="live-workspace-page" aria-label="项目文件">
      <div className="live-page-toolbar">
        <h2>工作区文件</h2>
        <span className="live-muted">版面预览与上传修改稿尚未接入。</span>
      </div>
      {workspace.isPending && <p role="status">正在加载工作区…</p>}
      {workspace.isError && (
        <p className="live-error" role="alert">
          {errorMessage(workspace.error)}{' '}
          <button className="live-text-button" onClick={() => void workspace.refetch()}>
            重新加载工作区
          </button>
        </p>
      )}
      {workspace.data && (
        <div className="live-page-grid">
          <section className="live-page-card" aria-label="版本文件列表">
            <header className="live-page-card-head">
              <h3>{selectedVersion ? `第 ${selectedVersion.number} 版` : '当前已选版本'}</h3>
              {!files.isPending && !files.isError && (
                <span className="live-muted">
                  {items.length} 个文件{files.hasNextPage && '已加载'}
                </span>
              )}
            </header>
            <div className="live-asset-controls">
              <label>
                文件版本
                <select
                  aria-label="文件版本"
                  value={versionId ?? ''}
                  onChange={(event) => setSelected(event.target.value)}
                >
                  {!currentInHistory && (
                    <option value={workspace.data.currentVersionId}>当前版本</option>
                  )}
                  {history.map((version) => (
                    <option key={version.id} value={version.id}>
                      第 {version.number} 版
                      {version.id === workspace.data?.currentVersionId ? '（当前）' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                对比起点
                <select
                  aria-label="对比起点"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                >
                  <option value="">选择历史版本</option>
                  {history.map((version) => (
                    <option key={version.id} value={version.id}>
                      第 {version.number} 版
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="live-secondary"
                disabled={!from || !versionId || from === versionId}
                onClick={() => {
                  if (from && versionId && from !== versionId)
                    onOpenDiff({ projectId, from, to: versionId });
                }}
              >
                查看版本对比
              </button>
            </div>
            {selectedVersion?.summary && <p className="live-muted">{selectedVersion.summary}</p>}
            {versions.isError && (
              <p className="live-error live-assets-message" role="alert">
                {errorMessage(versions.error)}{' '}
                <button className="live-text-button" onClick={() => void versions.refetch()}>
                  重试历史版本
                </button>
              </p>
            )}
            {versions.hasNextPage && (
              <button
                type="button"
                className="live-text-button live-assets-more"
                disabled={versions.isFetchingNextPage}
                onClick={() => void versions.fetchNextPage()}
              >
                加载更多历史版本
              </button>
            )}
            {files.isPending && (
              <p className="live-assets-message" role="status">
                正在读取文件列表…
              </p>
            )}
            {files.isError && (
              <p className="live-error live-assets-message" role="alert">
                {errorMessage(files.error)}{' '}
                <button className="live-text-button" onClick={() => void files.refetch()}>
                  重试文件列表
                </button>
              </p>
            )}
            {items.map((file) => (
              <button
                className="live-asset-row"
                type="button"
                key={file.path}
                aria-label={`查看文件：${file.path}`}
                onClick={() => versionId && onOpenFile({ projectId, versionId, path: file.path })}
              >
                <span>
                  <span className="live-file-path">{file.path}</span>
                  <small>
                    {file.mediaType}，{file.byteSize.toLocaleString('zh-CN')} 字节
                  </small>
                </span>
                <span className="live-row-action">查看文件</span>
              </button>
            ))}
            {!files.isPending && !files.isError && items.length === 0 && (
              <p className="live-empty live-assets-message">这个版本没有文件。</p>
            )}
            {files.hasNextPage && (
              <button
                type="button"
                className="live-secondary live-assets-more"
                disabled={files.isFetchingNextPage}
                onClick={() => void files.fetchNextPage()}
              >
                加载更多文件
              </button>
            )}
          </section>
          <section className="live-page-card" aria-label="工作区版本历史">
            <header className="live-page-card-head">
              <h3>版本历史</h3>
            </header>
            {history.length > 0 ? (
              <ol className="live-version-timeline">
                {[...history].reverse().map((version) => (
                  <li key={version.id}>
                    <time dateTime={version.createdAt}>{displayTime(version.createdAt)}</time>
                    <p>
                      <button
                        className="live-text-button"
                        type="button"
                        onClick={() => setSelected(version.id)}
                      >
                        第 {version.number} 版
                      </button>{' '}
                      · {version.summary}
                    </p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="live-page-message live-muted">
                {versions.isError ? '版本列表暂时无法读取。' : '正在读取版本…'}
              </p>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
