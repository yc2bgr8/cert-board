import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ProjectRecord } from '@cert-board/shared';
import { api, errorMessage, type ConversationDetail } from './api.js';
import type { MemberNotificationSnapshot } from './useMemberNotifications.js';
import './pages.css';

type Notice = MemberNotificationSnapshot['items'][number];

export const noticeLabels: Record<Notice['kind'], string> = {
  approval: '批准请求',
  question: '提问',
  blocked: '阻塞',
  review: '待审核结果',
  proposal: '外发提案',
  deadline: '期限提醒',
  verification: '外部核实',
  outbound: '外发结果',
  skill: '技能回退提醒',
  knowledge_review: '知识审核',
};
const filters = [
  'all',
  'approval',
  'review',
  'knowledge_review',
  'proposal',
  'question',
  'blocked',
  'deadline',
  'verification',
  'outbound',
  'skill',
] as const;
const reviewKinds = new Set<Notice['kind']>(['review', 'proposal', 'knowledge_review']);
const time = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function displayTime(value: string) {
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? '时间待核对' : time.format(instant);
}

function noticeAction(kind: Notice['kind']) {
  if (kind === 'review') return '查看审核';
  if (kind === 'knowledge_review') return '查看审核卡';
  if (kind === 'proposal') return '查看提案';
  if (kind === 'verification') return '查看核实群聊';
  if (kind === 'outbound') return '查看和对账';
  if (kind === 'skill') return '查看技能提案';
  return '打开对话';
}

export function Inbox({
  snapshot,
  error,
  projects,
  onOpen,
}: {
  snapshot: MemberNotificationSnapshot | null;
  error: string | null;
  projects: readonly ProjectRecord[];
  onOpen(item: Notice): void;
}) {
  const [filter, setFilter] = useState<(typeof filters)[number]>('all');
  const acknowledge = useMutation({
    mutationFn: (item: Notice) => api.acknowledgeDeadline(item.id, item.createdAt),
  });
  const items = snapshot?.items ?? [];
  const upcoming = items
    .flatMap(({ id, deadline }) =>
      deadline && deadline.remainingDays >= 0 ? [{ id, ...deadline }] : [],
    )
    .sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt))
    .slice(0, 3);
  const visible = items.filter((item) => filter === 'all' || item.kind === filter);
  const groups = [
    {
      label: '需要处理',
      items: visible.filter((item) => !reviewKinds.has(item.kind)),
    },
    {
      label: '审核与提案',
      items: visible.filter((item) => reviewKinds.has(item.kind)),
    },
  ];
  return (
    <div className="live-workspace-page">
      {snapshot && (
        <div className="live-filter-pills" role="group" aria-label="按类型筛选待处理事项">
          {filters.map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {value === 'all' ? '全部' : noticeLabels[value]}{' '}
              {value === 'all' ? items.length : items.filter((item) => item.kind === value).length}
            </button>
          ))}
        </div>
      )}
      <div className="live-page-grid">
        <section className="live-page-card" aria-label="待我处理事项">
          {error && (
            <p className="live-page-message live-error" role="status">
              {error}
            </p>
          )}
          {acknowledge.error && (
            <p className="live-page-message live-error" role="alert">
              {errorMessage(acknowledge.error)}
            </p>
          )}
          {!snapshot && !error && (
            <p className="live-page-message" role="status">
              正在读取待处理事项…
            </p>
          )}
          {snapshot && !error && visible.length === 0 && (
            <p className="live-page-message live-muted">
              {filter === 'all' ? '暂时没有需要你处理的事项。' : '当前没有这个类型的待处理事项。'}
            </p>
          )}
          {groups
            .filter((group) => group.items.length > 0)
            .map((group) => (
              <section key={group.label}>
                <header className="live-page-card-head">
                  <h2>{group.label}</h2>
                </header>
                {group.items.map((item) =>
                  item.deadline ? (
                    <div
                      className="live-inbox-row live-page-list-row live-deadline-row"
                      key={`deadline:${item.id}`}
                    >
                      <span>
                        <strong>{item.deadline.title}</strong>
                        <span
                          className={`live-notice-chip is-${item.deadline.remainingDays < 0 ? 'blocked' : 'deadline'}`}
                        >
                          {item.deadline.remainingDays < 0
                            ? `逾期 ${-item.deadline.remainingDays} 天`
                            : item.deadline.remainingDays === 0
                              ? '当地今日到期'
                              : `剩余 ${item.deadline.remainingDays} 天`}
                        </span>
                      </span>
                      <time className="live-muted" dateTime={item.deadline.dueAt}>
                        {item.deadline.beijingTime}（北京）
                      </time>
                      <span className="live-deadline-actions">
                        <button
                          className="live-text-button"
                          type="button"
                          onClick={() => onOpen(item)}
                        >
                          打开对话
                        </button>
                        <button
                          className="live-secondary"
                          type="button"
                          disabled={acknowledge.isPending}
                          onClick={() => acknowledge.mutate(item)}
                        >
                          知道了
                        </button>
                      </span>
                    </div>
                  ) : (
                    <button
                      className="live-inbox-row live-page-list-row"
                      type="button"
                      key={`${item.kind}:${item.id}`}
                      onClick={() => onOpen(item)}
                    >
                      <span>
                        <strong>
                          {item.skillRollback
                            ? `${item.skillRollback.skillId} ${item.skillRollback.activeVersion}`
                            : item.knowledgeReview
                              ? `${item.knowledgeReview.title} ${item.knowledgeReview.version}`
                              : (projects.find((project) => project.id === item.projectId)?.name ??
                                '项目对话')}
                        </strong>
                        <span className={`live-notice-chip is-${item.kind}`}>
                          {item.verification?.kind === 'blocked'
                            ? '发起人或原对话已失去访问权限，未续跑'
                            : item.verification?.kind === 'late'
                              ? '迟到的核实结论'
                              : item.knowledgeReview
                                ? item.knowledgeReview.kind === 'rule_pack'
                                  ? '规则包待审阅'
                                  : '模板待审阅'
                                : noticeLabels[item.kind]}
                        </span>
                      </span>
                      <span className="live-muted">{displayTime(item.createdAt)}</span>
                      <span className="live-row-action">{noticeAction(item.kind)}</span>
                    </button>
                  ),
                )}
              </section>
            ))}
          {snapshot?.truncated && (
            <p className="live-page-message live-muted">还有待处理事项，处理后会继续更新。</p>
          )}
        </section>
        <aside className="live-page-side" aria-label="到期和完成记录">
          <section className="live-page-card">
            <header className="live-page-card-head">
              <h2>即将到期</h2>
            </header>
            {upcoming.length ? (
              <ul className="live-deadline-upcoming">
                {upcoming.map(({ id, title, remainingDays }) => (
                  <li key={id}>
                    <span>{title}</span>
                    <span className="live-muted">
                      {remainingDays === 0 ? '当地今日到期' : `还有 ${remainingDays} 天`}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="live-page-message live-muted">暂无待处理期限提醒。</p>
            )}
          </section>
          <section className="live-page-card">
            <header className="live-page-card-head">
              <h2>今天已完成</h2>
            </header>
            <p className="live-page-message live-muted">日摘要尚未接入。</p>
          </section>
        </aside>
      </div>
    </div>
  );
}

export function ProjectHomeAside({
  projectId,
  userId,
  snapshot,
  notificationError,
  conversations,
  onOpenNotice,
  onFiles,
}: {
  projectId: string;
  userId: string;
  snapshot: MemberNotificationSnapshot | null;
  notificationError: string | null;
  conversations: readonly ConversationDetail[];
  onOpenNotice(item: Notice): void;
  onFiles(): void;
}) {
  const items = snapshot?.items.filter((item) => item.projectId === projectId) ?? [];
  const workspace = useQuery({
    queryKey: ['live', 'workspace', userId, projectId],
    queryFn: ({ signal }) => api.workspace(projectId, signal),
    retry: false,
  });
  const versions = useQuery({
    queryKey: [
      'live',
      'workspace-recent-versions',
      workspace.data?.id,
      workspace.data?.currentVersionId,
    ],
    queryFn: ({ signal }) =>
      api.workspaceVersions(workspace.data!.id, { limit: 3, view: 'recent' }, signal),
    enabled: !!workspace.data,
    retry: false,
  });
  const history = versions.data?.items ?? [];
  return (
    <>
      <section className="live-page-card">
        <header className="live-page-card-head">
          <h2>需要你处理</h2>
          {items.length > 0 && <span className="live-notice-chip is-approval">{items.length}</span>}
        </header>
        {notificationError && (
          <p className="live-page-message live-error" role="status">
            {notificationError}
          </p>
        )}
        {items.length === 0 && !notificationError && (
          <p className="live-page-message live-muted">
            {snapshot
              ? snapshot.truncated
                ? '已读取的通知中没有当前项目的待处理事项。'
                : '当前项目没有待处理事项。'
              : '正在读取通知…'}
          </p>
        )}
        {items.map((item) => (
          <button
            type="button"
            className="live-inbox-row live-page-list-row"
            key={`${item.kind}:${item.id}`}
            onClick={() => onOpenNotice(item)}
          >
            <span>
              <span className={`live-notice-chip is-${item.kind}`}>{noticeLabels[item.kind]}</span>
              <span className="live-project-notice-detail">
                {conversations.find((conversation) => conversation.id === item.conversationId)
                  ?.title ?? '项目对话'}{' '}
                · {displayTime(item.createdAt)}
              </span>
            </span>
            <span className="live-row-action">{noticeAction(item.kind)}</span>
          </button>
        ))}
      </section>
      <section className="live-page-card">
        <header className="live-page-card-head">
          <h2>工作区版本</h2>
          <button type="button" className="live-text-button" onClick={onFiles}>
            全部文件
          </button>
        </header>
        {(workspace.isPending || (workspace.data && versions.isPending)) && (
          <p className="live-page-message live-muted" role="status">
            正在读取版本…
          </p>
        )}
        {(workspace.isError || versions.isError) && (
          <p className="live-page-message live-muted" role="status">
            工作区版本暂不可用，可以从文件页重试。
          </p>
        )}
        {history.length > 0 && (
          <ol className="live-version-timeline">
            {history.map((version) => (
              <li key={version.id}>
                <time dateTime={version.createdAt}>{displayTime(version.createdAt)}</time>
                <p>
                  <strong>第 {version.number} 版</strong> · {version.summary}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
