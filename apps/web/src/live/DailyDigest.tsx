import { useQuery } from '@tanstack/react-query';
import type { DailyDigestContent } from '@cert-board/shared';
import { api, errorMessage } from './api.js';

type Resource = DailyDigestContent['completed'][number];
type Notice = DailyDigestContent['pending'][number];

export function DailyDigest({
  onOpen,
  onOpenTarget,
  labels,
}: {
  onOpen(item: Notice): void;
  onOpenTarget: ((projectId: string, conversationId: string | null) => void) | undefined;
  labels: Record<Notice['kind'], string>;
}) {
  const query = useQuery({
    queryKey: ['live', 'daily-digest'],
    queryFn: ({ signal }) => api.dailyDigest(signal),
    retry: false,
    refetchInterval: 60_000,
  });
  const digest = query.data?.digest;
  const resourceButton = (item: Resource) =>
    onOpenTarget ? (
      <button
        className="live-text-button"
        type="button"
        onClick={() => onOpenTarget(item.projectId, item.conversationId)}
      >
        {item.title}
      </button>
    ) : (
      <span>{item.title}</span>
    );
  const groups = digest
    ? [
        { title: '今日完成', items: digest.completed },
        { title: '待你处理', items: digest.pending },
        { title: '明日到期', items: digest.tomorrow },
        { title: '本地测试消息', items: digest.localTestMessages },
      ]
    : [];

  return (
    <section className="live-page-card live-daily-digest" aria-label="日摘要">
      <header className="live-page-card-head">
        <h2>日摘要</h2>
        {digest && <time dateTime={digest.date}>{digest.date} · 北京时间</time>}
      </header>
      {query.isPending && (
        <p className="live-page-message" role="status">
          正在读取日摘要…
        </p>
      )}
      {query.isError && (
        <p className="live-page-message live-error" role="alert">
          {errorMessage(query.error)}
        </p>
      )}
      {query.data && !digest && (
        <p className="live-page-message live-muted">暂无已发布摘要。工作日 17:00 汇总。</p>
      )}
      {groups
        .filter(({ items }) => items.length > 0)
        .map(({ title, items }) => (
          <section key={title} className="live-page-message">
            <h3>{title}</h3>
            <ul>
              {items.map((item) => (
                <li key={item.id}>
                  {'kind' in item ? (
                    <button className="live-text-button" type="button" onClick={() => onOpen(item)}>
                      {item.deadline?.title ?? labels[item.kind]}
                    </button>
                  ) : (
                    resourceButton(item)
                  )}
                  {'dueOn' in item && typeof item.dueOn === 'string' && (
                    <small> 当地 {item.dueOn}</small>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      {digest && groups.every(({ items }) => items.length === 0) && (
        <p className="live-page-message live-muted">这期摘要的待处理事项已处理。</p>
      )}
      {digest?.truncated && (
        <p className="live-page-message live-muted">
          摘要显示部分记录，可在待处理事项及项目中查看更多。
        </p>
      )}
    </section>
  );
}
