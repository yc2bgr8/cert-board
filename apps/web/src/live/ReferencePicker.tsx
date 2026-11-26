import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api, errorMessage } from './api.js';
import { ShellIcon } from './ShellIcon.js';

export function ReferencePicker({
  projectId,
  conversationId,
  onSelect,
  onClose,
}: {
  projectId: string;
  conversationId: string;
  onSelect(reference: string): void;
  onClose(): void;
}) {
  const [search, setSearch] = useState('');
  const query = useInfiniteQuery({
    queryKey: ['live', 'conversation-references', conversationId, projectId],
    queryFn: ({ pageParam, signal }) =>
      api.documents(projectId, { limit: 25, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
  });
  const documents = query.data?.pages.flatMap((page) => page.items) ?? [];
  const term = search.trim().toLowerCase();
  const shown = documents.filter(({ name, sourceKey }) =>
    `${sourceKey} ${name}`.toLowerCase().includes(term),
  );
  return (
    <section className="live-reference-picker" role="dialog" aria-label="添加资料引用">
      <div className="live-reference-search">
        <ShellIcon name="search" />
        <input
          value={search}
          aria-label="筛选已加载的资料"
          placeholder="按资料名称或编号筛选"
          onChange={(event) => setSearch(event.target.value)}
        />
        <button
          type="button"
          className="live-composer-button"
          aria-label="关闭资料选择"
          onClick={onClose}
        >
          <ShellIcon name="close" />
        </button>
      </div>
      <div className="live-reference-results">
        {query.isPending && <p role="status">正在加载项目资料…</p>}
        {query.isError && (
          <p role="alert">
            {errorMessage(query.error)}{' '}
            <button type="button" onClick={() => void query.refetch()}>
              重试
            </button>
          </p>
        )}
        {shown.map((document) => (
          <button
            key={document.id}
            type="button"
            className="live-composer-option"
            onClick={() =>
              onSelect(
                `资料引用：${document.sourceKey}（文档编号 ${document.id}，第 ${document.currentVersion} 版）`,
              )
            }
          >
            <ShellIcon name="file" />
            <span>
              <strong>{document.name}</strong>
              <small>
                {document.sourceKey} · 第 {document.currentVersion} 版
              </small>
            </span>
          </button>
        ))}
        {query.isSuccess && !documents.length && <p>项目暂无可引用的已导入资料。</p>}
        {query.isSuccess && documents.length > 0 && !shown.length && (
          <p>已加载的资料中没有匹配项。</p>
        )}
        {query.hasNextPage && (
          <button
            type="button"
            className="live-composer-button"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            加载更多资料
          </button>
        )}
      </div>
    </section>
  );
}
