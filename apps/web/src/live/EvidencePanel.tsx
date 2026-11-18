import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api, errorMessage } from './api.js';
import type { EvidenceTarget } from './review-navigation.js';
import { exactQuoteParts, joinTextPages } from './text-pages.js';
import './review-panels.css';

export function EvidencePanel({ sources }: { sources: EvidenceTarget[] }) {
  return <EvidenceGroup key={JSON.stringify(sources)} sources={sources} />;
}
function EvidenceGroup({ sources }: { sources: EvidenceTarget[] }) {
  const [first, setFirst] = useState(0);
  if (!sources.length) return <p className="review-panel-empty">当前没有可打开的资料引用。</p>;
  return (
    <section className="review-evidence-panel" aria-label="资料依据">
      <p className="review-panel-note">当前提供解析原文。原件文件与原页图像尚未导入。</p>
      <div className={`review-evidence-grid${sources.length > 1 ? ' is-comparison' : ''}`}>
        {sources.slice(first, first + 2).map((source, index) => (
          <EvidenceSource
            key={`${source.documentId}:${source.version}:${source.page}:${index}`}
            source={source}
          />
        ))}
      </div>
      {sources.length > 2 && (
        <nav className="review-panel-pagination" aria-label="引用组分页">
          <button
            type="button"
            disabled={first === 0}
            onClick={() => setFirst(Math.max(0, first - 2))}
          >
            上一组依据
          </button>
          <span>
            第 {first + 1}–{Math.min(first + 2, sources.length)} 条，共 {sources.length} 条
          </span>
          <button
            type="button"
            disabled={first + 2 >= sources.length}
            onClick={() => setFirst(first + 2)}
          >
            下一组依据
          </button>
        </nav>
      )}
    </section>
  );
}
function EvidenceSource({ source }: { source: EvidenceTarget }) {
  const query = useInfiniteQuery({
    queryKey: ['live', 'evidence', source.documentId, source.version, source.page],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      api.documentPage(
        source.documentId,
        source.version,
        source.page,
        { offset: pageParam, limit: 8000 },
        signal,
      ),
    getNextPageParam: (last) => (last.truncated ? (last.nextOffset ?? undefined) : undefined),
    retry: false,
  });
  const pages = query.data?.pages ?? [];
  const first = pages[0];
  let combined: ReturnType<typeof joinTextPages> | undefined,
    failure: string | null = null;
  try {
    if (
      pages.some(
        (page) =>
          page.documentId !== source.documentId ||
          page.version !== source.version ||
          page.page !== source.page ||
          page.contentSha256 !== first?.contentSha256,
      )
    )
      throw new Error('source_mismatch');
    combined = joinTextPages(pages);
  } catch {
    failure = '资料定位或续读内容不一致，请重新加载当前引用。';
  }
  const match = combined ? exactQuoteParts(combined.text, source.quote) : null;
  return (
    <section
      className="review-evidence-source"
      aria-label={
        first
          ? `${first.sourceKey} 第 ${source.page} ${first.locatorKind === 'extraction_unit' ? '提取单元' : '页'}原文`
          : '资料原文'
      }
    >
      <h3>{first ? `${first.sourceKey} · ${first.name}` : '资料原文'}</h3>
      <p className="review-panel-meta">
        第 {source.version} 版 · 第 {source.page}{' '}
        {first?.locatorKind === 'extraction_unit' ? '提取单元' : '页'}
      </p>
      {first?.warning && (
        <p className="review-panel-warning" role="status">
          {first.warning}
        </p>
      )}
      {typeof first?.ocrScore === 'number' && (
        <p className="review-panel-meta">识别置信度 {(first.ocrScore * 100).toFixed(1)}%</p>
      )}
      {query.isPending && <p role="status">正在读取解析原文…</p>}
      {(query.isError || failure) && (
        <p className="review-panel-error" role="alert">
          {failure ?? errorMessage(query.error)}{' '}
          <button type="button" onClick={() => void query.refetch()}>
            重新读取原文
          </button>
        </p>
      )}
      {first && !failure && combined && (
        <>
          <pre className="review-original-text" aria-label={`${first.sourceKey}解析原文`}>
            {match ? (
              <>
                {match.before}
                <mark>{match.match}</mark>
                {match.after}
              </>
            ) : (
              combined.text || '本页解析文本为空。'
            )}
          </pre>
          {source.quote && !match && (
            <p className="review-panel-warning">
              {combined.complete
                ? '已读原文中没有逐字一致的引用，请核对引用与原件；未自动改写原文。'
                : '当前片段尚未覆盖逐字一致的引用，请继续读取核对。'}
            </p>
          )}
          <p className="review-panel-meta">
            已读取 {combined.text.length} / {combined.totalCharacters} 个字符
          </p>
        </>
      )}
      {query.hasNextPage && !failure && (
        <button
          className="review-panel-more"
          type="button"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? '正在续读…' : '继续读取原文'}
        </button>
      )}
    </section>
  );
}
