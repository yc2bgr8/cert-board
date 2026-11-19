import { useInfiniteQuery } from '@tanstack/react-query';
import { api, errorMessage } from './api.js';

export function ReferencePicker({
  projectId,
  conversationId,
  onSelect,
}: {
  projectId: string;
  conversationId: string;
  onSelect(reference: string): void;
}) {
  const query = useInfiniteQuery({
    queryKey: ['live', 'conversation-references', conversationId, projectId],
    queryFn: ({ pageParam, signal }) =>
      api.documents(projectId, { limit: 25, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
  });
  const documents = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section className="live-reference-picker" aria-label="添加资料引用">
      {query.isPending && <p role="status">正在加载项目资料…</p>}
      {query.isError && (
        <p role="alert">
          {errorMessage(query.error)}{' '}
          <button type="button" onClick={() => void query.refetch()}>
            重试
          </button>
        </p>
      )}
      {documents.map((document) => (
        <button
          key={document.id}
          type="button"
          onClick={() =>
            onSelect(
              `资料引用：${document.sourceKey}（文档编号 ${document.id}，第 ${document.currentVersion} 版）`,
            )
          }
        >
          <span>{document.sourceKey}</span> {document.name}
        </button>
      ))}
      {query.isSuccess && !documents.length && <p>项目暂无可引用的已导入资料。</p>}
      {query.hasNextPage && (
        <button
          type="button"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          加载更多资料
        </button>
      )}
    </section>
  );
}
