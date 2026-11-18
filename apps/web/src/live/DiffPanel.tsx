import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, errorMessage } from './api.js';
import type { WorkspaceDiffTarget, WorkspaceFileTarget } from './review-navigation.js';
import './review-panels.css';

type Props = { target: WorkspaceDiffTarget; onOpenFile: (target: WorkspaceFileTarget) => void };
export function DiffPanel(props: Props) {
  return <DiffContent key={JSON.stringify(props.target)} {...props} />;
}
function DiffContent({ target, onOpenFile }: Props) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const path = target.path ?? selectedPath ?? undefined;
  const workspace = useQuery({
    queryKey: ['live', 'workspace', target.projectId],
    queryFn: ({ signal }) => api.workspace(target.projectId, signal),
    retry: false,
  });
  const query = useInfiniteQuery({
    queryKey: ['live', 'workspace-diff', workspace.data?.id, target.from, target.to, path ?? null],
    enabled: !!workspace.data,
    initialPageParam: {} as { cursor?: string; offset?: number },
    queryFn: ({ pageParam, signal }) =>
      api.workspaceDiff(
        workspace.data!.id,
        { from: target.from, to: target.to, ...(path ? { path } : {}), ...pageParam, limit: 50 },
        signal,
      ),
    getNextPageParam: (last) =>
      last.kind === 'files'
        ? last.hasMore && last.nextCursor
          ? { cursor: last.nextCursor }
          : undefined
        : last.kind === 'text' && last.diff.hasMore && last.diff.nextOffset !== null
          ? { offset: last.diff.nextOffset }
          : undefined,
    retry: false,
  });
  const pages = query.data?.pages ?? [],
    first = pages[0];
  const wrong = pages.some(
    (page, index) =>
      page.kind !== first?.kind ||
      (page.kind !== 'files' && page.path !== path) ||
      (page.kind === 'text' &&
        ((index === 0 && page.diff.offset !== 0) ||
          (index > 0 &&
            pages[index - 1]?.kind === 'text' &&
            (pages[index - 1] as typeof page).diff.nextOffset !== page.diff.offset) ||
          page.beforeSha256 !== (first?.kind === 'text' ? first.beforeSha256 : null) ||
          page.afterSha256 !== (first?.kind === 'text' ? first.afterSha256 : null))),
  );
  const open = (versionId: string, filename: string) =>
    onOpenFile({ projectId: target.projectId, versionId, path: filename });
  return (
    <section className="review-diff-panel" aria-label="工作区改动对比">
      <p className="review-panel-meta">
        比较已保存版本 <code>{target.from}</code> 与 <code>{target.to}</code>
      </p>
      {selectedPath && !target.path && (
        <button type="button" className="review-panel-more" onClick={() => setSelectedPath(null)}>
          返回文件变化
        </button>
      )}
      {path && <h3 className="review-panel-path">{path}</h3>}
      {(workspace.isPending || (workspace.data && query.isPending)) && (
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
      {!wrong && first?.kind === 'files' && (
        <>
          {first.changes.length === 0 && pages.length === 1 && (
            <p className="review-panel-empty">两个版本没有文件变化。</p>
          )}
          <ul className="review-file-changes">
            {pages
              .flatMap((page) => (page.kind === 'files' ? page.changes : []))
              .map((change) => (
                <li key={change.path}>
                  <p className="review-panel-path">{change.path}</p>
                  <p className="review-panel-meta">
                    {change.change === 'added'
                      ? '新增'
                      : change.change === 'deleted'
                        ? '删除'
                        : '修改'}
                  </p>
                  <div className="review-panel-actions">
                    <button
                      type="button"
                      aria-label={`查看文本对比：${change.path}`}
                      onClick={() => setSelectedPath(change.path)}
                    >
                      查看文本对比
                    </button>
                    <button
                      type="button"
                      aria-label={`打开文件：${change.path}`}
                      onClick={() => open(change.after ? target.to : target.from, change.path)}
                    >
                      打开文件
                    </button>
                  </div>
                </li>
              ))}
          </ul>
        </>
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
              <div className="review-text-diff" role="region" aria-label="文本差异">
                {pages
                  .flatMap((page) => (page.kind === 'text' ? page.diff.lines : []))
                  .map((line, index) => (
                    <div
                      className={`review-diff-line is-${line.kind}`}
                      data-change={line.kind}
                      key={index}
                    >
                      <span className="review-diff-number" aria-label="旧行号">
                        {line.oldLine ?? '—'}
                      </span>
                      <span className="review-diff-number" aria-label="新行号">
                        {line.newLine ?? '—'}
                      </span>
                      <pre>
                        <span aria-hidden="true">
                          {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '− ' : '  '}
                        </span>
                        {line.text}
                        {line.lineTruncated && (
                          <span className="review-panel-warning">（本行已截断）</span>
                        )}
                      </pre>
                    </div>
                  ))}
              </div>
              {pages.some((page) => page.kind === 'text' && page.diff.warning) && (
                <p className="review-panel-warning">部分内容有读取限制，请打开文件核对完整文本。</p>
              )}
            </>
          )}
        </>
      )}
      {!wrong && first && first.kind !== 'files' && path && (
        <div className="review-panel-actions">
          {first.beforeSha256 && (
            <button type="button" onClick={() => open(target.from, path)}>
              打开对比起点文件
            </button>
          )}
          {first.afterSha256 && (
            <button type="button" onClick={() => open(target.to, path)}>
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
    </section>
  );
}
