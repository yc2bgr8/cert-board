import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from './api.js';

export function M02Schedule({
  goalId,
  userId,
  canEnable,
}: {
  goalId: string;
  userId: string;
  canEnable: boolean;
}) {
  const client = useQueryClient();
  const queryKey = ['live', 'm02-schedule', userId, goalId];
  const schedule = useQuery({ queryKey, queryFn: ({ signal }) => api.m02Schedule(goalId, signal) });
  const save = useMutation({
    mutationFn: ({ enabled, expectedVersion }: { enabled: boolean; expectedVersion: number }) =>
      api.saveM02Schedule(goalId, { enabled, expectedVersion }),
    onSuccess: (saved) => client.setQueryData(queryKey, saved),
    onError: () => void client.invalidateQueries({ queryKey }),
  });
  if (schedule.isError) return <small role="alert">{errorMessage(schedule.error)}</small>;
  if (!schedule.data) return null;
  const { available, enabled, version } = schedule.data;
  if (!available && !enabled) return <small>定时核查暂不可用。</small>;
  return (
    <div>
      <button
        aria-pressed={enabled}
        className="live-text-button"
        type="button"
        disabled={save.isPending || (!enabled && !canEnable)}
        onClick={() => save.mutate({ enabled: !enabled, expectedVersion: version })}
      >
        {enabled ? '停用定时核查' : '启用定时核查'}
      </button>
      {save.isError && <small role="alert">{errorMessage(save.error)}</small>}
    </div>
  );
}
