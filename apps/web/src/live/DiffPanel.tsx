import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { UnifiedDiffViewer } from './UnifiedDiffViewer.js';
import { api, errorMessage } from './api.js';
import type { WorkspaceDiffTarget, WorkspaceFileTarget } from './review-navigation.js';
import './review-panels.css';

type Props = { target: WorkspaceDiffTarget; onOpenFile: (target: WorkspaceFileTarget) => void };
export function DiffPanel(props: Props) {
  return <DiffContent key={JSON.stringify(props.target)} {...props} />;
}
function DiffContent({ target, onOpenFile }: Props) {
  const [path, setPath] = useState(target.path);
  const workspace = useQuery({
    queryKey: ['live', 'workspace', target.projectId],
    queryFn: ({ signal }) => api.workspace(target.projectId, signal),
    retry: false,
  });
  const files = useInfiniteQuery({
    queryKey: ['live', 'workspace-diff-files', workspace.data?.id, target.from, target.to],
    enabled: !!workspace.data,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const page = await api.workspaceDiff(
        workspace.data!.id,
        {
          from: target.from,
          to: target.to,
          ...(pageParam ? { cursor: pageParam } : {}),
          limit: 50,
        },
        signal,
      );
      if (page.kind !== 'files') throw new Error('文件清单的响应类型无效。');
      return page;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });
  const versions = useQuery({
    queryKey: ['live', 'review-workspace-versions', workspace.data?.id],
    queryFn: ({ signal }) => api.workspaceVersions(workspace.data!.id, { limit: 50 }, signal),
    enabled: !!workspace.data,
    retry: false,
  });
  const changedFiles = files.data?.pages.flatMap((page) => page.changes) ?? [];
  const label = (id: string) => {
    const version = versions.data?.items.find((item) => item.id === id);
    return version ? `第 ${version.number} 版` : id.slice(0, 8);
  };
  const query = useInfiniteQuery({
    queryKey: ['live', 'workspace-diff', workspace.data?.id, target.from, target.to, path ?? null],
    enabled: !!workspace.data && !!path,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      api.workspaceDiff(
        workspace.data!.id,
        { from: target.from, to: target.to, path: path!, offset: pageParam, limit: 50 },
        signal,
      ),
    getNextPageParam: (last) =>
      last.kind === 'text' && last.diff.hasMore ? (last.diff.nextOffset ?? undefined) : undefined,
    retry: false,
  });
  const pages = query.data?.pages ?? [],
    first = pages[0];
  const wrong = pages.some(
    (page, index) =>
      page.kind === 'files' ||
      page.kind !== first?.kind ||
      page.path !== path ||
      (page.kind === 'text' &&
        ((index === 0 && page.diff.offset !== 0) ||
          (index > 0 &&
            pages[index - 1]?.kind === 'text' &&
            (pages[index - 1] as typeof page).diff.nextOffset !== page.diff.offset) ||
          page.beforeSha256 !== (first?.kind === 'text' ? first.beforeSha256 : null) ||
          page.afterSha256 !== (first?.kind === 'text' ? first.afterSha256 : null))),
  );
  const open = (versionId: string) =>
    path && onOpenFile({ projectId: target.projectId, versionId, path });
  return (
    <section className="review-diff-panel" aria-label="工作区改动对比">
      <p className="review-panel-meta">
        比较已保存版本{' '}
        <span className="live-review-chip" title={target.from}>
          {label(target.from)} →
        </span>{' '}
        <span className="live-review-chip" title={target.to}>
          {label(target.to)}
        </span>
      </p>
      <div className="review-diff-columns">
        <nav aria-label="改动文件列表">
          {files.data && (
            <p className="review-panel-meta">
              {changedFiles.length} 项文件改动{files.hasNextPage && '（已读取）'}
            </p>
          )}
          {files.isError && (
            <p role="alert" className="review-panel-error">
              {errorMessage(files.error)}{' '}
              <button type="button" onClick={() => void files.refetch()}>
                重新读取清单
              </button>
            </p>
          )}
          {files.isSuccess && changedFiles.length === 0 && (
            <p className="review-panel-empty">两个版本没有文件变化。</p>
          )}
          <ul className="review-diff-files">
            {changedFiles.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  aria-current={path === file.path ? 'true' : undefined}
                  aria-label={`查看文本对比：${file.path}`}
                  onClick={() => setPath(file.path)}
                >
                  <span className="review-panel-path">{file.path}</span>
                  <span className="live-review-chip">
                    {{ added: '新增', deleted: '删除', modified: '修改' }[file.change]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {files.hasNextPage && (
            <button
              type="button"
              className="review-panel-more"
              disabled={files.isFetchingNextPage}
              onClick={() => void files.fetchNextPage()}
            >
              继续读取文件列表
            </button>
          )}
        </nav>
        <div className="review-diff-detail">
          {path && <h3 className="review-panel-path">{path}</h3>}
          {(workspace.isPending ||
            (workspace.data && (path ? query.isPending : files.isPending))) && (
            <p role="status">正在读取版本差异…</p>
          )}
          {(workspace.isError || query.isError || wrong) && (
            <p role="alert" className="review-panel-error">
              {wrong
                ? '对比内容或续读位置不一致，请重新加载。'
                : errorMessage(workspace.error ?? query.error)}{' '}
              <button
                type="button"
                onClick={() => void (workspace.isError ? workspace.refetch() : query.refetch())}
              >
                重新读取对比
              </button>
            </p>
          )}
          {!path && changedFiles.length > 0 && (
            <p className="review-panel-empty">选择改动文件查看对比。</p>
          )}
          {!wrong && first?.kind === 'binary' && (
            <p className="review-panel-warning" role="status">
              {first.warning}{' '}
              <span>
                修改前：{first.beforeSha256 ?? '不存在'}；修改后：{first.afterSha256 ?? '不存在'}
              </span>
            </p>
          )}
          {!wrong && first?.kind === 'text' && (
            <>
              {!first.diff.available && (
                <p className="review-panel-warning" role="status">
                  {first.diff.warning ?? '当前文本超出差异计算上限。'} 未将空白结果视为没有变化。
                </p>
              )}
              {first.diff.available && (
                <>
                  <p className="review-panel-meta">
                    新增 {first.diff.added} 行，删除 {first.diff.removed} 行
                  </p>
                  <UnifiedDiffViewer
                    lines={pages.flatMap((page) => (page.kind === 'text' ? page.diff.lines : []))}
                  />
                  {pages.some((page) => page.kind === 'text' && page.diff.warning) && (
                    <p className="review-panel-warning">
                      部分内容有读取限制，请打开文件核对完整文本。
                    </p>
                  )}
                </>
              )}
            </>
          )}
          {!wrong && first && first.kind !== 'files' && path && (
            <div className="review-panel-actions">
              {first.beforeSha256 && (
                <button type="button" onClick={() => open(target.from)}>
                  打开对比起点文件
                </button>
              )}
              {first.afterSha256 && (
                <button type="button" onClick={() => open(target.to)}>
                  打开对比目标文件
                </button>
              )}
            </div>
          )}
          {query.hasNextPage && !wrong && (
            <button
              type="button"
              className="review-panel-more"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? '正在续读…' : '继续读取差异'}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
