import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ToolApprovalDecisionInput } from '@cert-board/shared';
import { api, ApiError, createRequestKey, errorMessage, isStaleError } from './api.js';

export function useBrowserCommand() {
  const keys = useRef(new Map<string, string>());
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(
    action: unknown[],
    execute: (requestKey: string) => Promise<T>,
    onError?: (error: unknown) => void,
  ) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    const fingerprint = JSON.stringify(action);
    try {
      const key = keys.current.get(fingerprint) ?? createRequestKey();
      if (keys.current.size >= 32 && !keys.current.has(fingerprint)) {
        const first = keys.current.keys().next().value;
        if (first) keys.current.delete(first);
      }
      keys.current.set(fingerprint, key);
      const result = await execute(key);
      keys.current.delete(fingerprint);
      return result;
    } catch (failure) {
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500) {
        keys.current.delete(fingerprint);
      }
      setError(errorMessage(failure));
      onError?.(failure);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return { busy, error, run };
}

const actions: { value: ToolApprovalDecisionInput['action']; label: string }[] = [
  { value: 'allow_once', label: '允许' },
  { value: 'allow_conversation', label: '本对话中都允许' },
  { value: 'reject', label: '拒绝' },
];
const statusLabels = { approved: '已允许', rejected: '已拒绝', cancelled: '已取消' };
const fieldNames: Record<string, string> = {
  status: '状态',
  content: '内容',
  version: '版本',
  draft_version: '工作副本版本',
  workspace_version: '工作区版本',
  summary: '摘要',
};
function previewValue(value: unknown) {
  if (value === null) return '无';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

export function ApprovalCard({ approvalId, disabled }: { approvalId: string; disabled: boolean }) {
  const query = useQuery({
    queryKey: ['live', 'approval', approvalId],
    queryFn: ({ signal }) => api.approval(approvalId, signal),
    retry: false,
  });
  const command = useBrowserCommand();
  const [reason, setReason] = useState('');
  const [decision, setDecision] = useState<'approved' | 'rejected' | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const approval = query.data;
  const status = decision ?? approval?.status;
  function decide(action: ToolApprovalDecisionInput['action']) {
    if (
      !approval ||
      status !== 'pending' ||
      disabled ||
      command.busy ||
      query.isFetching ||
      refreshing
    )
      return;
    const trimmed = action === 'reject' ? reason.trim() : '';
    void command
      .run(
        [action, approval.version, approval.contentHash, trimmed],
        (requestKey) =>
          api.decideApproval(approvalId, {
            action,
            requestKey,
            expectedVersion: approval.version,
            expectedContentHash: approval.contentHash,
            ...(trimmed ? { reason: trimmed } : {}),
          }),
        (failure) => {
          if (isStaleError(failure)) {
            setRefreshing(true);
            void query.refetch().finally(() => setRefreshing(false));
          }
        },
      )
      .then((result) => {
        if (result) setDecision(result.status);
      });
  }
  return (
    <section className="live-approval" aria-label="批准请求">
      <h2>批准请求</h2>
      {approval ? (
        <>
          <div className="live-approval-body">
            <p>{approval.preview.summary}</p>
            {approval.preview.changes.map((change, index) => (
              <div className="live-preview-change" key={index}>
                <p>{fieldNames[change.field] ?? change.field}</p>
                <p className="live-conversation-meta">
                  {change.recordType} · {change.recordId}
                </p>
                <dl>
                  <div>
                    <dt>改前</dt>
                    <dd>{previewValue(change.before)}</dd>
                  </div>
                  <div>
                    <dt>改后</dt>
                    <dd>{previewValue(change.after)}</dd>
                  </div>
                </dl>
              </div>
            ))}
            {approval.preview.message && (
              <dl className="live-preview-message">
                <div>
                  <dt>收件人</dt>
                  <dd>{approval.preview.message.recipientName}</dd>
                </div>
                <div>
                  <dt>主题</dt>
                  <dd>{approval.preview.message.subject}</dd>
                </div>
                <div>
                  <dt>内容</dt>
                  <dd>{approval.preview.message.body}</dd>
                </div>
              </dl>
            )}
            {status === 'pending' && (
              <details className="live-reject-details">
                <summary>填写拒绝原因（可选）</summary>
                <label className="live-reject-reason">
                  拒绝原因（可选）
                  <textarea
                    rows={2}
                    value={reason}
                    maxLength={2000}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </label>
              </details>
            )}
          </div>
          {status === 'pending' && (
            <div className="live-approval-actions">
              {actions.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  className={value === 'allow_once' ? 'live-approval-primary' : undefined}
                  disabled={
                    disabled || command.busy || query.isFetching || refreshing || query.isError
                  }
                  onClick={() => decide(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {status && status !== 'pending' && (
            <p className="live-conversation-meta" role="status">
              {statusLabels[status]}
            </p>
          )}
          {command.error && (
            <p className="live-command-error" role="alert">
              {command.error}
            </p>
          )}
        </>
      ) : null}
      {query.isError && (
        <p className="live-command-error" role="alert">
          {errorMessage(query.error)}{' '}
          <button type="button" onClick={() => void query.refetch()}>
            重试
          </button>
        </p>
      )}
      {!approval && !query.isError && (
        <p role="status" className="live-conversation-meta">
          正在读取批准请求…
        </p>
      )}
    </section>
  );
}
