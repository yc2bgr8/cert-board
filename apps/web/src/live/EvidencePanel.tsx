// 参考 VisaFlow app/apps/electron/src/renderer/visaflow/MaterialRecognitionDialog.tsx。
// 改为按项目资料版本并排读取，原页可用性与解析文字独立显示。
import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, ApiError, errorMessage } from './api.js';
import type { EvidenceTarget } from './review-navigation.js';
import { exactQuoteParts, joinTextPages } from './text-pages.js';
import './review-panels.css';

const sourceTypes = { official: '官方来源', extended: '扩展来源', general: '一般网站' };
const archiveTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function EvidencePanel({ sources }: { sources: EvidenceTarget[] }) {
  return <EvidenceGroup key={JSON.stringify(sources)} sources={sources} />;
}
function EvidenceGroup({ sources }: { sources: EvidenceTarget[] }) {
  const [first, setFirst] = useState(0);
  const [compare, setCompare] = useState(sources.length > 1);
  if (!sources.length) return <p className="review-panel-empty">当前没有可打开的资料引用。</p>;
  const count = compare ? 2 : 1;
  return (
    <section className="review-evidence-panel" aria-label="资料依据">
      <header className="review-evidence-toolbar">
        <span className="live-review-chip">{sources.length} 处来源</span>
        {sources.length > 1 && (
          <div className="review-preview-toggle" role="group" aria-label="显示方式">
            <button
              type="button"
              aria-pressed={compare}
              onClick={() => {
                setFirst(first === sources.length - 1 ? first - 1 : first);
                setCompare(true);
              }}
            >
              并排对照
            </button>
            <button type="button" aria-pressed={!compare} onClick={() => setCompare(false)}>
              单份
            </button>
          </div>
        )}
      </header>
      <div className={`review-evidence-grid${compare ? ' is-comparison' : ''}`}>
        {sources.slice(first, first + count).map((source, index) => (
          <EvidenceSource
            key={`${source.documentId}:${source.version}:${source.page}:${index}`}
            source={source}
            number={first + index + 1}
          />
        ))}
      </div>
      {sources.length > count && (
        <nav className="review-panel-pagination" aria-label="引用组分页">
          <button
            type="button"
            disabled={first === 0}
            onClick={() => setFirst(Math.max(0, first - count))}
          >
            上一组依据
          </button>
          <span>
            第 {first + 1}–{Math.min(first + count, sources.length)} 条，共 {sources.length} 条
          </span>
          <button
            type="button"
            disabled={first + count >= sources.length}
            onClick={() => setFirst(first + count)}
          >
            下一组依据
          </button>
        </nav>
      )}
    </section>
  );
}
function EvidenceSource({ source, number }: { source: EvidenceTarget; number: number }) {
  const textPane = useRef<HTMLPreElement>(null);
  const highlight = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);
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
  const archiveQuery = useQuery({
    queryKey: ['live', 'web-archive-info', source.documentId, source.version],
    queryFn: ({ signal }) => api.webArchiveInfo(source.documentId, source.version, signal),
    enabled: query.error instanceof ApiError && query.error.code === 'DOCUMENT_PLACEHOLDER',
    retry: false,
  });
  const webArchive = first?.webArchive ?? archiveQuery.data;
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
  const before = match?.before.split('\n').slice(-4).join('\n');
  const after = match?.after.split('\n').slice(0, 4).join('\n');
  const excerpt = !!match && (before !== match.before || after !== match.after);
  const hasMatch = Boolean(match);
  useEffect(() => {
    if (textPane.current)
      textPane.current.scrollTop =
        hasMatch && highlight.current ? Math.max(0, highlight.current.offsetTop - 60) : 0;
  }, [hasMatch, expanded, source.quote]);
  return (
    <section
      className="review-evidence-source"
      aria-label={
        first
          ? `${first.sourceKey} 第 ${source.page} ${first.locatorKind === 'extraction_unit' ? '提取单元' : '页'}原文`
          : '资料原文'
      }
    >
      <h3>
        <span className="review-source-number">{number}</span>
        {first ? `${first.sourceKey} · ${first.name}` : '资料原文'}
      </h3>
      <p className="review-panel-meta">
        第 {source.version} 版 · 第 {source.page}{' '}
        {first?.locatorKind === 'extraction_unit' ? '提取单元' : '页'}
      </p>
      {webArchive && (
        <div className="review-original-unavailable" aria-label="网页存档">
          <p>
            {sourceTypes[webArchive.sourceType]} ·{' '}
            {archiveTime.format(new Date(webArchive.fetchedAt))}
          </p>
          <p>{new URL(webArchive.url).hostname}</p>
          <a href={api.webArchiveHref(source.documentId, source.version)} download>
            下载原始网页存档
          </a>
        </div>
      )}
      {first?.warning && (
        <p className="review-original-unavailable" role="status">
          {first.warning}
        </p>
      )}
      {typeof first?.ocrScore === 'number' && (
        <p className="review-panel-meta">识别置信度 {(first.ocrScore * 100).toFixed(1)}%</p>
      )}
      {query.isPending && <p role="status">正在读取解析原文…</p>}
      {query.isError && webArchive && (
        <p className="review-panel-meta">该原件的解析正文尚未导入。</p>
      )}
      {((query.isError && !webArchive) || failure) && (
        <p className="review-panel-error" role="alert">
          {failure ?? errorMessage(query.error)}{' '}
          <button type="button" onClick={() => void query.refetch()}>
            重新读取原文
          </button>
        </p>
      )}
      {first && !failure && combined && (
        <>
          <pre
            ref={textPane}
            className="review-original-text"
            aria-label={`${first.sourceKey}解析原文`}
          >
            {match ? (
              <>
                {expanded ? match.before : before !== match.before ? `…\n${before}` : before}
                <mark ref={highlight}>{match.match}</mark>
                {expanded ? match.after : after !== match.after ? `${after}\n…` : after}
              </>
            ) : (
              combined.text || '本页解析文本为空。'
            )}
          </pre>
          {excerpt && (
            <button
              type="button"
              className="review-panel-more"
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? '收起解析全文' : '展开解析全文'}
            </button>
          )}
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
