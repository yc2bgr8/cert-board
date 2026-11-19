import { useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocumentCitation, ReviewCardView, ReviewDecisionInput } from '@cert-board/shared';
import { SafeMarkdown } from '../SafeMarkdown.js';
import { useBrowserCommand } from './ApprovalCard.js';
import { api, errorMessage, isStaleError } from './api.js';
import type {
  EvidenceTarget,
  WorkspaceDiffTarget,
  WorkspaceFileTarget,
} from './review-navigation.js';
import './review.css';

type Props = {
  reviewId: string;
  onOpenEvidence(sources: EvidenceTarget[]): void;
  onOpenDiff(target: WorkspaceDiffTarget): void;
  onOpenFile(target: WorkspaceFileTarget): void;
};

const statusLabels = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已退回修改',
  cancelled: '已取消',
};
const checkStatus = { passed: '通过', failed: '未通过', not_run: '未执行' };
const claimStatus = { checked: '已核对', inferred: '推断', unverified: '待核对' };
const changeLabels = { added: '新增', modified: '修改', deleted: '删除' };
const dateTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  dateStyle: 'medium',
  timeStyle: 'short',
});

function ReviewSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="live-review-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function evidenceKey(ref: DocumentCitation) {
  return JSON.stringify([ref.documentId, ref.version, ref.page, ref.quote]);
}

function evidenceLabel(card: ReviewCardView, ref: DocumentCitation) {
  const checked = card.checks.citations.find(
    (item) =>
      item.documentId === ref.documentId && item.version === ref.version && item.page === ref.page,
  );
  const locator = checked?.locatorKind === 'extraction_unit' ? '提取单元' : checked ? '页' : '位置';
  return `${checked?.sourceKey ?? '资料'} · 第 ${ref.version} 版 · ${ref.page} ${locator}`;
}

export function ReviewCard(props: Props) {
  return <ReviewCardContent key={props.reviewId} {...props} />;
}

function ReviewCardContent({ reviewId, onOpenEvidence, onOpenDiff, onOpenFile }: Props) {
  const client = useQueryClient();
  const reviewKey = ['live', 'review', reviewId];
  const review = useQuery({
    queryKey: reviewKey,
    queryFn: ({ signal }) => api.review(reviewId, signal),
    retry: false,
  });
  const card = review.data;
  const projectId = card?.projectId ?? null;
  const workspace = useQuery({
    queryKey: ['live', 'review-workspace', projectId],
    queryFn: ({ signal }) => api.workspace(projectId!, signal),
    enabled: projectId !== null,
    retry: false,
  });
  const versions = useQuery({
    queryKey: ['live', 'review-workspace-versions', workspace.data?.id],
    queryFn: ({ signal }) => api.workspaceVersions(workspace.data!.id, { limit: 50 }, signal),
    enabled: !!workspace.data,
    retry: false,
  });
  const command = useBrowserCommand();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [conflict, setConflict] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [receipt, setReceipt] = useState<{
    status: 'approved' | 'rejected';
    snapshotId: string | null;
  } | null>(null);
  if (!card)
    return (
      <section className="live-review">
        <h2>审核卡</h2>
        {review.isError ? (
          <>
            <p role="alert">{errorMessage(review.error)}</p>
            <button
              type="button"
              className="live-review-link"
              onClick={() => void review.refetch()}
            >
              重试
            </button>
          </>
        ) : (
          <p role="status">正在读取审核卡…</p>
        )}
      </section>
    );

  const version = versions.data?.items.find((item) => item.id === card.workspaceVersion);
  const savedStatus = receipt?.status ?? card.status;
  const oldVersion = !!workspace.data && workspace.data.currentVersionId !== card.workspaceVersion;
  const pending = savedStatus === 'pending';
  const mayDecide =
    pending &&
    !!workspace.data &&
    !workspace.isError &&
    !workspace.isFetching &&
    !review.isError &&
    !review.isFetching &&
    !oldVersion &&
    !conflict &&
    !refreshing &&
    !command.busy;
  const sources = [...new Map(card.evidenceRefs.map((ref) => [evidenceKey(ref), ref])).values()];
  const secondLocation = sources.find(
    (ref) =>
      ref.documentId !== sources[0]?.documentId ||
      ref.version !== sources[0]?.version ||
      ref.page !== sources[0]?.page,
  );
  const { baseVersionId } = card.diff;
  const { submission } = card;

  function refresh() {
    setRefreshing(true);
    void Promise.all([review.refetch(), workspace.refetch()])
      .then(([freshReview, freshWorkspace]) => {
        if (freshReview.isSuccess && freshWorkspace.isSuccess) {
          setConflict(null);
          setRejecting(false);
        }
      })
      .finally(() => setRefreshing(false));
  }

  function decide(action: ReviewDecisionInput['action']) {
    if (!card || !mayDecide) return;
    const decisionReason = action === 'rejected' ? reason.trim() : null;
    if (action === 'rejected' && !decisionReason) return;
    void command
      .run(
        [action, card.version, card.workspaceVersion, decisionReason],
        (requestKey) =>
          api.decideReview(reviewId, {
            requestKey,
            expectedVersion: card.version,
            workspaceVersion: card.workspaceVersion,
            action,
            reason: decisionReason,
          }),
        (error) => {
          if (isStaleError(error)) setConflict(errorMessage(error));
        },
      )
      .then((result) => {
        if (!result) return;
        setReceipt(result);
        setRejecting(false);
        void client.invalidateQueries({ queryKey: reviewKey });
      });
  }

  function reject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    decide('rejected');
  }

  return (
    <article className="live-review" aria-label="审核结果">
      <header className="live-review-header">
        <h2>审核卡</h2>
        <p role="status">{statusLabels[savedStatus]}</p>
        <p className="live-review-meta">
          工作区版本{' '}
          <span className="live-review-identifier" title={card.workspaceVersion}>
            {version ? `第 ${version.number} 版` : card.workspaceVersion}
          </span>
        </p>
      </header>
      {((oldVersion && pending) || conflict || review.isError || workspace.isError) && (
        <div className="live-review-warning" role="alert">
          <p>
            {conflict ??
              (oldVersion && pending
                ? '工作区已保存为新版本。请核对并打开最新提交的审核卡。'
                : '当前审核状态无法确认，请刷新后重试。')}
          </p>
          <button
            type="button"
            className="live-review-link"
            disabled={refreshing}
            onClick={refresh}
          >
            刷新审核卡
          </button>
        </div>
      )}
      <ReviewSection title="结论">
        <SafeMarkdown workbench>{submission.conclusion}</SafeMarkdown>
      </ReviewSection>
      <ReviewSection title="需要你做什么">
        <SafeMarkdown workbench>{submission.nextStep}</SafeMarkdown>
      </ReviewSection>
      <ReviewSection title="过程中作出的判断">
        {submission.decisions.length === 0 ? (
          <p className="live-review-meta">
            {card.legacySubmission
              ? '这份历史提交没有结构化判断记录。'
              : '这次提交没有列出过程判断。'}
          </p>
        ) : (
          <ul className="live-review-decisions">
            {submission.decisions.map((decision) => (
              <li key={decision.id}>
                <h4>{decision.subject}</h4>
                <dl>
                  <div>
                    <dt>选择</dt>
                    <dd>{decision.choice}</dd>
                  </div>
                  <div>
                    <dt>备选</dt>
                    <dd>
                      {decision.alternatives.length ? decision.alternatives.join('；') : '未列出'}
                    </dd>
                  </div>
                  <div>
                    <dt>理由</dt>
                    <dd>{decision.reason}</dd>
                  </div>
                  <div>
                    <dt>风险</dt>
                    <dd>{decision.risk === 'high' ? '高' : '低'}</dd>
                  </div>
                </dl>
                <ul className="live-review-reference-links">
                  {decision.sources.map((ref, index) => (
                    <li key={`${evidenceKey(ref)}:${index}`}>
                      <button
                        className="live-review-link"
                        type="button"
                        onClick={() => onOpenEvidence([ref])}
                      >
                        {evidenceLabel(card, ref)}
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </ReviewSection>
      <ReviewSection title="改动">
        {!card.diff.changes.length && <p className="live-review-meta">没有工作区文件改动。</p>}
        {baseVersionId && card.diff.changes.length > 0 && (
          <button
            type="button"
            className="live-review-link"
            onClick={() =>
              onOpenDiff({
                projectId: card.projectId,
                from: baseVersionId,
                to: card.workspaceVersion,
              })
            }
          >
            查看版本改动
          </button>
        )}
        <ul className="live-review-file-list">
          {card.diff.changes.map((file) => {
            const readableVersion =
              file.change === 'deleted' ? baseVersionId : card.workspaceVersion;
            return (
              <li key={file.path}>
                <span className="live-review-identifier">{file.path}</span>
                <span className="live-review-meta">{changeLabels[file.change]}</span>
                <div className="live-review-actions">
                  {baseVersionId && (
                    <button
                      type="button"
                      className="live-review-link"
                      onClick={() =>
                        onOpenDiff({
                          projectId: card.projectId,
                          from: baseVersionId,
                          to: card.workspaceVersion,
                          path: file.path,
                        })
                      }
                    >
                      查看对比
                    </button>
                  )}
                  {readableVersion && (
                    <button
                      type="button"
                      className="live-review-link"
                      onClick={() =>
                        onOpenFile({
                          projectId: card.projectId,
                          versionId: readableVersion,
                          path: file.path,
                        })
                      }
                    >
                      {file.change === 'deleted' ? '打开原文件' : '打开文件'}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </ReviewSection>
      <ReviewSection title="依据">
        {sources[0] && secondLocation && (
          <button
            type="button"
            className="live-review-link"
            onClick={() => onOpenEvidence([sources[0]!, secondLocation])}
          >
            并排查看两处依据
          </button>
        )}
        {sources.length === 0 && <p className="live-review-meta">这份提交没有列出来源。</p>}
        <ul className="live-review-evidence-list">
          {sources.map((ref) => (
            <li key={evidenceKey(ref)}>
              <p className="live-review-meta">{evidenceLabel(card, ref)}</p>
              <blockquote>{ref.quote}</blockquote>
              <button
                type="button"
                className="live-review-link"
                onClick={() => onOpenEvidence([ref])}
              >
                查看原文
              </button>
            </li>
          ))}
        </ul>
      </ReviewSection>
      <ReviewSection title="自检">
        <ul className="live-review-check-list">
          {card.checks.checks.map((check) => (
            <li key={check.code}>
              <span className="live-review-identifier">{check.code}</span>
              <span className={check.status === 'passed' ? 'live-review-check-passed' : undefined}>
                {checkStatus[check.status]}
              </span>
            </li>
          ))}
        </ul>
        <p className="live-review-meta">未执行 {card.checks.notRun.join('、')}</p>
        <details className="live-review-claims">
          <summary>核对的陈述</summary>
          <ul>
            {submission.claims.map((claim) => (
              <li key={claim.id}>
                {claim.object} · {claim.field}{' '}
                <span className="live-review-identifier">
                  {claim.value}
                  {claim.unit && ` ${claim.unit}`}
                </span>{' '}
                <span className="live-review-meta">{claimStatus[claim.status]}</span>
              </li>
            ))}
          </ul>
        </details>
      </ReviewSection>
      <ReviewSection title="不确定事项">
        {submission.uncertain.length + submission.missing.length === 0 ? (
          <p className="live-review-meta">未列出不确定事项。</p>
        ) : (
          <>
            {submission.uncertain.length > 0 && (
              <ul className="live-review-bullets">
                {submission.uncertain.map((value, index) => (
                  <li key={index}>{value}</li>
                ))}
              </ul>
            )}
            {submission.missing.length > 0 && (
              <>
                <h4>待补资料</h4>
                <ul className="live-review-bullets">
                  {submission.missing.map((value, index) => (
                    <li key={index}>{value}</li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </ReviewSection>
      <ReviewSection title="操作">
        {pending ? (
          <>
            <div className="live-review-actions">
              <button
                type="button"
                className="live-review-primary"
                disabled={!mayDecide || rejecting}
                onClick={() => decide('approved')}
              >
                通过
              </button>
              <button
                type="button"
                className="live-review-neutral"
                disabled={!mayDecide || rejecting}
                onClick={() => setRejecting(true)}
              >
                退回修改
              </button>
            </div>
            {!workspace.data && !workspace.isError && (
              <p role="status" className="live-review-meta">
                正在核对当前工作区版本…
              </p>
            )}
            {rejecting && (
              <form className="live-review-reject" onSubmit={reject}>
                <label>
                  退回原因
                  <textarea
                    value={reason}
                    rows={3}
                    maxLength={2000}
                    required
                    onChange={(event) => setReason(event.target.value)}
                  />
                </label>
                <div className="live-review-actions">
                  <button
                    type="submit"
                    className="live-review-primary"
                    disabled={!mayDecide || !reason.trim()}
                  >
                    确认退回
                  </button>
                  <button
                    type="button"
                    className="live-review-neutral"
                    disabled={command.busy}
                    onClick={() => setRejecting(false)}
                  >
                    取消
                  </button>
                </div>
              </form>
            )}
            {command.error && !conflict && (
              <p className="live-review-error" role="alert">
                {command.error}
              </p>
            )}
          </>
        ) : (
          <div className="live-review-outcome">
            <p>
              {savedStatus === 'approved' && (receipt?.snapshotId ?? card.decision?.snapshotId)
                ? '已通过，工作区版本已冻结。'
                : statusLabels[savedStatus]}
            </p>
            {card.decision?.reason && <p>{card.decision.reason}</p>}
            {card.decidedAt && (
              <p className="live-review-meta">
                {dateTime.format(new Date(card.decidedAt))}（北京时间）
              </p>
            )}
          </div>
        )}
      </ReviewSection>
    </article>
  );
}
