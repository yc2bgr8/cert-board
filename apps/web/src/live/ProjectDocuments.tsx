import { useInfiniteQuery } from '@tanstack/react-query';
import { api, errorMessage } from './api.js';
import type { EvidenceTarget } from './review-navigation.js';

export function ProjectDocuments({
  projectId,
  userId,
  onOpenEvidence,
}: {
  projectId: string;
  userId: string;
  onOpenEvidence(sources: EvidenceTarget[]): void;
}) {
  const query = useInfiniteQuery({
    queryKey: ['live', 'project-documents', userId, projectId],
    queryFn: ({ pageParam, signal }) =>
      api.documents(projectId, { limit: 50, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section className="live-overview live-project-assets" aria-label="项目资料">
      <h2>资料库</h2>
      <p className="live-muted">查看已导入资料的解析文本。原文件预览与上传暂未开放。</p>
      {query.isPending && <p role="status">正在加载资料…</p>}
      {query.isError && (
        <p className="live-error" role="alert">
          {errorMessage(query.error)}{' '}
          <button className="live-text-button" type="button" onClick={() => void query.refetch()}>
            重新加载资料
          </button>
        </p>
      )}
      {items.map((document) => (
        <button
          className="live-asset-row"
          type="button"
          key={document.id}
          aria-label={`打开资料：${document.name}`}
          onClick={() =>
            onOpenEvidence([{ documentId: document.id, version: document.currentVersion, page: 1 }])
          }
        >
          <span>
            {document.name}
            <small>
              {document.sourceKey}，第 {document.currentVersion} 版，
              {{ public: '公开', internal: '内部', confidential: '保密' }[document.dataLevel]}
            </small>
          </span>
          <span className="live-row-action">打开解析页</span>
        </button>
      ))}
      {!query.isPending && !query.isError && items.length === 0 && (
        <p className="live-empty">这个项目还没有可查看的资料。</p>
      )}
      {query.hasNextPage && (
        <button
          type="button"
          className="live-secondary"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          加载更多资料
        </button>
      )}
    </section>
  );
}
