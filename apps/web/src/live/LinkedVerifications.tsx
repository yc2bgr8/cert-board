import { useInfiniteQuery } from '@tanstack/react-query';
import type { VerificationLinkView } from '@cert-board/shared';
import { api } from './api.js';
import { ShellIcon } from './ShellIcon.js';

const titles = {
  pending: '正在请外部模型核实…',
  available: '外部核实已完成',
  unavailable: '外部核实暂不可用',
};
const badges = { trusted: '可信', disputed: '有分歧', unverified: '待核实', human: '人工提供' };

export const linkedVerificationsKey = (conversationId: string | null) => [
  'live',
  'linked-verifications',
  conversationId,
];
export const reviewVerificationsKey = (reviewId: string) => [
  'live',
  'review-verifications',
  reviewId,
];

export function useLinkedVerifications(id: string | null, inReview = false) {
  const load = inReview ? api.reviewVerifications : api.linkedVerifications;
  const query = useInfiniteQuery({
    queryKey: inReview ? reviewVerificationsKey(id ?? '') : linkedVerificationsKey(id),
    queryFn: ({ signal, pageParam }) => load(id!, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: Boolean(id),
    retry: false,
  });
  return {
    ...query,
    items:
      query.data?.pages
        .slice()
        .reverse()
        .flatMap((page) => page.items) ?? [],
  };
}

export function LinkedVerificationRows({
  items,
  open,
  inReview = false,
}: {
  items: VerificationLinkView[];
  open(id: string): void;
  inReview?: boolean;
}) {
  if (!items.length) return null;
  return (
    <ul
      className="verification-link-list"
      aria-label={inReview ? '外部核实依据' : '对话中的外部核实'}
    >
      {items.map(({ room, result, summary, counts, sources }) => (
        <li className="verification-link-row" key={room.id}>
          <ShellIcon name="sparkle" />
          <div>
            <strong>{inReview && result === 'available' ? '外部核实' : titles[result]}</strong>
            {room.status === 'completed' && (
              <span className="verification-link-counts">
                {Object.entries(counts)
                  .filter(([, count]) => count > 0)
                  .map(([category, count]) => (
                    <span key={category} className={`verification-badge ${category}`}>
                      {badges[category as keyof typeof badges]} {count}
                    </span>
                  ))}
              </span>
            )}
            {summary && <p>{summary}</p>}
            {inReview && sources.length > 0 && (
              <ul className="verification-sources" aria-label="外部核实出处">
                {sources.map((source) => (
                  <li key={source.url}>
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="点击后打开外部网站"
                    >
                      {source.title}
                      <span className="external-link-notice">（外部网站）</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {result === 'unavailable' && <p>仍可按项目资料继续工作。</p>}
          </div>
          <button className="live-secondary" type="button" onClick={() => open(room.id)}>
            {inReview ? '查看核实群聊' : '查看群聊'}
          </button>
        </li>
      ))}
    </ul>
  );
}
