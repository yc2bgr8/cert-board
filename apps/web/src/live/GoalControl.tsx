import { useId, useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation } from '@tanstack/react-query';
import {
  goalTakeoverStatuses,
  type GoalControlInput,
  type GoalControlResult,
  type GoalRecord,
} from '@cert-board/shared';
import { api, ApiError, errorMessage } from './api.js';

export function GoalControl({
  goal,
  userId,
  onChanged,
  onRefresh,
}: {
  goal: GoalRecord;
  userId: string;
  onChanged(result: GoalControlResult): void;
  onRefresh(): void;
}) {
  const noteId = useId();
  const [draft, setDraft] = useState<GoalControlInput | null>(null);
  const mutation = useMutation({
    mutationFn: (input: GoalControlInput) => api.controlGoal(goal.id, input),
    onSuccess(result) {
      onChanged(result);
      setDraft(null);
    },
    onError(error) {
      if (error instanceof ApiError && (error.status === 409 || error.status === 403)) onRefresh();
    },
  });
  const available = goal.status === 'human_controlled'
    ? 'handoff'
    : goalTakeoverStatuses.some((status) => status === goal.status)
      ? 'takeover'
      : null;
  const action = goal.ownerUserId === userId ? available : null;
  if (!action && !draft) return null;

  const conflict = mutation.error instanceof ApiError && mutation.error.status === 409;
  const stale = !!draft && (conflict || draft.expectedVersion !== goal.version || draft.action !== action);
  const label = action === 'handoff' ? '交还' : '接管';
  const handoff = draft?.action === 'handoff';
  const title = handoff ? '交还目标' : '接管目标';
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft && !stale && !mutation.isPending && draft.note.trim()) mutation.mutate(draft);
  }

  return (
    <Dialog.Root
      open={draft !== null}
      onOpenChange={(open) => {
        if (open && action) {
          mutation.reset();
          setDraft({ action, expectedVersion: goal.version, note: '' });
        } else if (!open && !mutation.isPending) setDraft(null);
      }}
    >
      {action && <Dialog.Trigger className="live-text-button">{label}</Dialog.Trigger>}
      {draft && (
        <Dialog.Portal>
          <Dialog.Overlay className="live-search-scrim" />
          <Dialog.Content className="live-dialog">
            <div className="live-dialog-heading">
              <Dialog.Title>{title}</Dialog.Title>
            </div>
            <Dialog.Description className="live-muted">
              {goal.title}。{handoff ? 'Agent 将按处理记录继续。' : '接管后暂停自动执行和唤醒。'}
            </Dialog.Description>
            <form className="live-goal-control-form" onSubmit={submit}>
              <label htmlFor={noteId}>{handoff ? '处理结果' : '接管说明'}</label>
              <textarea
                id={noteId}
                value={draft.note}
                rows={4}
                maxLength={4000}
                required
                disabled={mutation.isPending}
                onChange={(event) => setDraft({ ...draft, note: event.target.value })}
              />
              {stale && (
                <p className="live-error" role="alert">目标已更新。请核对状态后重新打开操作。</p>
              )}
              {!stale && mutation.error && (
                <p className="live-error" role="alert">{errorMessage(mutation.error)}</p>
              )}
              <div className="live-goal-control-actions">
                <Dialog.Close className="live-secondary" disabled={mutation.isPending}>
                  取消
                </Dialog.Close>
                <button
                  className="live-primary"
                  type="submit"
                  disabled={stale || mutation.isPending || !draft.note.trim()}
                >
                  {mutation.isPending ? '正在保存…' : title}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      )}
    </Dialog.Root>
  );
}
