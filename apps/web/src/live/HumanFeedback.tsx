import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { HumanFeedbackInput } from '@cert-board/shared';
import { useBrowserCommand } from './ApprovalCard.js';
import { api, errorMessage } from './api.js';

export function HumanFeedback({
  conversationId,
  kind,
  targetId,
}: {
  conversationId: string;
  kind: HumanFeedbackInput['kind'];
  targetId: string;
}) {
  const [interacted, setInteracted] = useState(false);
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState('');
  const [saved, setSaved] = useState(false);
  const cmd = useBrowserCommand();
  const client = useQueryClient();
  const queryKey = ['live', 'human-feedback', conversationId, kind, targetId];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => api.humanFeedback(conversationId, { kind, targetId }, signal),
    enabled: interacted,
    staleTime: 20_000,
    retry: false,
  });
  const value = query.data?.item?.rating;

  async function editReason() {
    if (editing) return;
    const latest = await query.refetch({ cancelRefetch: false });
    if (latest.isError || !latest.data) return;
    setReason(latest.data.item?.reason ?? '');
    setEditing(true);
  }

  async function submit(rating: HumanFeedbackInput['rating']) {
    const note = rating === 'unhelpful' ? reason.trim() || null : null;
    const receipt = await cmd.run([conversationId, kind, targetId, rating, note], (requestKey) =>
      api.saveHumanFeedback(conversationId, { kind, targetId, requestKey, rating, reason: note }),
    );
    if (!receipt) return;
    await client.cancelQueries({ queryKey });
    client.setQueryData(queryKey, { item: receipt });
    setSaved(true);
    setEditing(false);
    setReason('');
    await client.invalidateQueries({ queryKey });
  }

  return (
    <div
      className="live-human-feedback"
      role="group"
      aria-label={kind === 'review' ? '审核卡反馈' : 'Agent 消息反馈'}
      onFocus={() => setInteracted(true)}
      onMouseEnter={() => setInteracted(true)}
    >
      <div className="live-human-feedback-actions">
        <button
          type="button"
          aria-pressed={value === 'helpful'}
          disabled={cmd.busy}
          onClick={() => void submit('helpful')}
        >
          有用
        </button>
        <button
          type="button"
          aria-pressed={value === 'unhelpful'}
          aria-expanded={editing}
          disabled={cmd.busy}
          onClick={() => void editReason()}
        >
          没用
        </button>
        {saved && <small role="status">已记录反馈</small>}
      </div>
      {editing && (
        <form
          className="live-human-feedback-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void submit('unhelpful');
          }}
        >
          <label>
            反馈原因（选填）
            <textarea
              aria-label="反馈原因（选填）"
              rows={2}
              value={reason}
              maxLength={600}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <button type="submit" disabled={cmd.busy}>
            提交反馈
          </button>
          <button type="button" onClick={() => setEditing(false)}>
            取消
          </button>
        </form>
      )}
      {cmd.error && (
        <small role="alert" className="live-error">
          {cmd.error}
        </small>
      )}
      {query.isError && (
        <small role="alert" className="live-error">
          {errorMessage(query.error)}
        </small>
      )}
    </div>
  );
}
