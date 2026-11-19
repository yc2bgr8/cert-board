import { useInfiniteQuery } from '@tanstack/react-query';
import { api, errorMessage } from './api.js';
import type { EvidenceTarget } from './review-navigation.js';

const parseLabels = { queued: '等待解析', running: '解析中', ready: '已解析', failed: '解析失败' };

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
    refetchInterval: ({ state }) =>
      state.data?.pages.some((page) =>
        page.items.some(
          (document) => document.parseState === 'queued' || document.parseState === 'running',
        ),
      )
        ? 2_000
        : false,
    retry: false,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section className="live-workspace-page live-documents-page" aria-label="项目资料">
      <section className="live-page-card" aria-label="整包导入">
        <header className="live-page-card-head">
          <h2>整包导入</h2>
          <span className="live-notice-chip">尚未接入</span>
        </header>
        <p className="live-page-message live-muted">
          原文件预览与上传暂未开放。已导入的解析文字可从资料库打开。
        </p>
      </section>
      <section className="live-page-card" aria-label="已导入资料">
        <header className="live-page-card-head">
          <h2>资料库</h2>
          {!query.isPending && !query.isError && (
            <span className="live-muted">
              {items.length} 份{query.hasNextPage && '已加载'}
            </span>
          )}
        </header>
        {query.isPending && (
          <p className="live-assets-message" role="status">
            正在加载资料…
          </p>
        )}
        {query.isError && (
          <p className="live-error live-assets-message" role="alert">
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
            disabled={document.parseState !== undefined && document.parseState !== 'ready'}
            aria-label={`打开资料：${document.name}`}
            onClick={() =>
              onOpenEvidence([
                { documentId: document.id, version: document.currentVersion, page: 1 },
              ])
            }
          >
            <span>
              {document.name}
              <small>
                {document.sourceKey}，第 {document.currentVersion} 版，
                {{ public: '公开', internal: '内部', confidential: '保密' }[document.dataLevel]}
              </small>
            </span>
            {document.parseState ? (
              <span className="live-notice-chip" data-parse-state={document.parseState}>
                {parseLabels[document.parseState]}
              </span>
            ) : (
              <span className="live-row-action">打开解析页</span>
            )}
          </button>
        ))}
        {!query.isPending && !query.isError && items.length === 0 && (
          <p className="live-empty live-assets-message">这个项目还没有可查看的资料。</p>
        )}
        {query.hasNextPage && (
          <button
            type="button"
            className="live-secondary live-assets-more"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            加载更多资料
          </button>
        )}
      </section>
    </section>
  );
}
