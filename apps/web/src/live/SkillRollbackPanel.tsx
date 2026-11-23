import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  SkillRollbackDecisionInput,
  SkillRollbackPolicy,
  SkillRollbackProposal,
} from '@cert-board/shared';
import { api, createRequestKey, errorMessage } from './api.js';

const beijing = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  dateStyle: 'medium',
  timeStyle: 'short',
});
const percent = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 });
const rate = ({ total, rejected }: { total: number; rejected: number }) =>
  percent.format(total ? rejected / total : 0);

function PolicyForm({ userId, policy }: { userId: string; policy: SkillRollbackPolicy }) {
  const client = useQueryClient();
  const [minimum, setMinimum] = useState(String(policy.minimumCards));
  const [rejection, setRejection] = useState(String(policy.rejectionPercent));
  const mutation = useMutation({
    mutationFn: () =>
      api.saveSkillRollbackPolicy({
        minimumCards: Number(minimum),
        rejectionPercent: Number(rejection),
        expectedRevision: policy.revision,
      }),
    onSuccess: (saved) => client.setQueryData(['live', 'skill-rollback-policy', userId], saved),
  });
  return (
    <form
      className="live-skill-selectors"
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
    >
      <label>
        最少已处理审核卡
        <input
          aria-label="最少已处理审核卡"
          type="number"
          min={1}
          max={100}
          required
          value={minimum}
          onChange={(event) => setMinimum(event.currentTarget.value)}
        />
      </label>
      <label>
        退回率阈值（%）
        <input
          aria-label="退回率阈值"
          type="number"
          min={1}
          max={100}
          required
          value={rejection}
          onChange={(event) => setRejection(event.currentTarget.value)}
        />
      </label>
      <button className="live-secondary" type="submit" disabled={mutation.isPending}>
        保存退回阈值
      </button>
      {mutation.isError && (
        <p role="alert" className="live-error">
          {errorMessage(mutation.error)}
        </p>
      )}
    </form>
  );
}

export function SkillRollbackPanel({
  userId,
  focusId,
}: {
  userId: string;
  focusId: string | null;
}) {
  const client = useQueryClient();
  const queryKey = ['live', 'skill-rollback-proposals', userId];
  const settings = useQuery({
    queryKey: ['live', 'skill-rollback-policy', userId],
    queryFn: ({ signal }) => api.skillRollbackPolicy(signal),
  });
  const proposals = useQuery({
    queryKey,
    queryFn: ({ signal }) => api.skillRollbackProposals(signal),
    refetchInterval: 30_000,
  });
  const mutation = useMutation({
    mutationFn: ({
      item,
      action,
    }: {
      item: SkillRollbackProposal;
      action: SkillRollbackDecisionInput['action'];
    }) =>
      api.decideSkillRollback(item.id, {
        action,
        expectedRevision: item.releaseRevision,
        requestKey: createRequestKey(),
      }),
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey }),
        client.invalidateQueries({ queryKey: ['live', 'skill-versions', userId] }),
      ]);
    },
  });
  useEffect(() => {
    if (!focusId || !proposals.data?.items.some(({ id }) => id === focusId)) return;
    const item = document.getElementById(`skill-rollback-${focusId}`);
    item?.scrollIntoView({ block: 'nearest' });
    item?.focus({ preventScroll: true });
  }, [focusId, proposals.data]);
  return (
    <section className="live-page-message" aria-label="技能回退与阈值">
      <h3>技能回退与阈值</h3>
      {settings.data && (
        <PolicyForm key={settings.data.revision} userId={userId} policy={settings.data} />
      )}
      {settings.isError && (
        <p role="alert" className="live-error">
          {errorMessage(settings.error)}
        </p>
      )}
      {proposals.isError && (
        <p role="alert" className="live-error">
          {errorMessage(proposals.error)}
        </p>
      )}
      {proposals.data?.items.map((item) => (
        <article
          key={item.id}
          id={`skill-rollback-${item.id}`}
          tabIndex={-1}
          className="live-skill-review-card"
          aria-label="技能回退提案"
        >
          <h3>
            {item.skillId} {item.activeVersion}
          </h3>
          <p>
            样本 {item.evidence.total} 张，退回 {item.evidence.rejected} 张，退回率{' '}
            {rate(item.evidence)}。
          </p>
          <p>
            样本时间 {beijing.format(new Date(item.evidence.from))} 至{' '}
            {beijing.format(new Date(item.evidence.to))}（北京）。
          </p>
          {item.previousVersion && (
            <p>
              上一版 {item.previousVersion}。
              {item.evidence.previous
                ? `当时退回率 ${rate(item.evidence.previous)}，样本 ${item.evidence.previous.total} 张。`
                : '当时暂无已处理样本。'}
            </p>
          )}
          {item.evidence.reasons.length > 0 && (
            <>
              <h4>近期内部退回原因</h4>
              <ul>
                {item.evidence.reasons.map((reason, index) => (
                  <li key={index}>{reason}</li>
                ))}
              </ul>
            </>
          )}
          {item.status === 'notice' && <p>当前技能没有可回退的上一版。</p>}
          {item.status === 'pending' && (
            <button
              type="button"
              className="live-primary"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate({ item, action: 'approve' })}
            >
              批准退回上一版
            </button>
          )}
          <button
            type="button"
            className="live-secondary"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate({ item, action: 'dismiss' })}
          >
            {item.status === 'notice' ? '知道了' : '驳回回退提案'}
          </button>
        </article>
      ))}
      {mutation.isError && (
        <p role="alert" className="live-error">
          {errorMessage(mutation.error)}
        </p>
      )}
    </section>
  );
}
