import { useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { OutboundResolutionInput, ProposalDecision, ProposalRecord } from '@cert-board/shared';
import { useBrowserCommand } from './ApprovalCard.js';
import { api, errorMessage, isStaleError } from './api.js';
import './review.css';

export const proposalStatusLabels: Record<ProposalRecord['status'], string> = {
  proposed: '待批准',
  approved: '已批准，等待本地测试',
  executing: '正在处理',
  done: '本地测试完成',
  failed: '本地测试失败',
  reconcile: '需要核对',
  rejected: '已拒绝',
  expired: '已过期',
};
const time = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function ProposalCard({
  proposalId,
  onRepropose,
}: {
  proposalId: string;
  onRepropose?(proposal: ProposalRecord): void;
}) {
  const client = useQueryClient();
  const key = ['live', 'proposal', proposalId];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.proposal(proposalId, signal),
    retry: false,
  });
  const command = useBrowserCommand();
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [conflict, setConflict] = useState(false);
  const proposal = query.data;
  const resultKey = ['live', 'outbound-result', proposalId];
  const reconciliation = useQuery({
    queryKey: resultKey,
    queryFn: ({ signal }) => api.outboundReconciliation(proposalId, signal),
    enabled: proposal?.status === 'reconcile' || proposal?.status === 'failed',
    retry: false,
  });

  if (!proposal)
    return (
      <div className="live-review-content">
        {query.isError ? (
          <>
            <p role="alert">{errorMessage(query.error)}</p>
            <button type="button" className="live-review-link" onClick={() => void query.refetch()}>
              重新读取
            </button>
          </>
        ) : (
          <p role="status">正在读取外发提案…</p>
        )}
      </div>
    );

  const mayDecide =
    proposal.status === 'proposed' &&
    !query.isFetching &&
    !query.isError &&
    !command.busy &&
    !conflict;

  function decide(action: ProposalDecision['action']) {
    if (!proposal || !mayDecide) return;
    void command
      .run(
        [action, proposal.version],
        (requestKey) =>
          api.decideProposal(proposalId, {
            expectedVersion: proposal.version,
            action,
            requestKey,
          }),
        (error) => {
          if (isStaleError(error)) setConflict(true);
        },
      )
      .then((result) => {
        if (!result) return;
        client.setQueryData(key, { ...proposal, status: result.status, version: result.version });
        void client.invalidateQueries({ queryKey: key });
        void client.invalidateQueries({
          queryKey: ['live', 'conversation-proposals', proposal.conversationId],
        });
      });
  }
  function resolve(action: OutboundResolutionInput['action']) {
    if (!proposal || !reconciliation.data || reconciliation.isFetching || command.busy) return;
    const expectedVersion = reconciliation.data.version;
    void command
      .run(['outbound', action, expectedVersion], (requestKey) =>
        api.resolveOutbound(proposalId, { action, expectedVersion, requestKey }),
      )
      .then((changed) => {
        if (!changed) return;
        client.setQueryData(resultKey, null);
        void client.invalidateQueries({ queryKey: key });
        void client.invalidateQueries({
          queryKey: ['live', 'conversation-proposals', proposal.conversationId],
        });
        if (action === 'repropose' && mounted.current) onRepropose?.(proposal);
      });
  }

  return (
    <article className="live-review live-panel-card" aria-label="提案内容">
      <div className="live-review-content">
        <div className="live-review-heading">
          <h2 className="sr-only">外发提案</h2>
          <span className="live-review-chip is-warning">本地测试</span>
          <span className="live-review-chip" role="status">
            {proposalStatusLabels[proposal.status]}
          </span>
        </div>
        <p className="live-review-meta">
          生成于 {time.format(new Date(proposal.createdAt))}（北京时间）
        </p>
        <dl className="live-proposal-fields">
          <dt>收件人</dt>
          <dd>
            {proposal.recipientName} &lt;{proposal.recipientAddress}&gt;
          </dd>
          <dt>主题</dt>
          <dd>{proposal.subject}</dd>
          <dt>正文</dt>
          <dd className="live-proposal-body">{proposal.body}</dd>
        </dl>
        <section className="live-review-section">
          <h3>批准与队列</h3>
          <p>批准前由后端重新核对登记联系人、提案版本和目标状态。批准后进入本地测试队列。</p>
        </section>
        {reconciliation.data && (
          <section className="live-review-section" aria-label="核对发送结果">
            <h3>核对发送结果</h3>
            <p>
              {reconciliation.data.reproposeRecorded
                ? '已记录重新提出。可回原对话准备一条新提案请求。'
                : reconciliation.data.status === 'reconcile'
                  ? '模拟发送结果未知，请按发送编号核对。'
                  : '模拟发送服务明确拒收。'}
            </p>
            <p>
              <code>{reconciliation.data.dispatchId}</code>
            </p>
            <div className="live-review-actions">
              {!reconciliation.data.reproposeRecorded &&
                reconciliation.data.status === 'reconcile' && (
                  <button
                    type="button"
                    className="live-review-primary"
                    disabled={command.busy || reconciliation.isFetching}
                    onClick={() => resolve('confirm_sent')}
                  >
                    确认模拟已发出
                  </button>
                )}
              <button
                type="button"
                className="live-review-neutral"
                disabled={command.busy || reconciliation.isFetching}
                onClick={() => {
                  if (reconciliation.data?.reproposeRecorded) onRepropose?.(proposal);
                  else resolve('repropose');
                }}
              >
                {reconciliation.data.reproposeRecorded ? '打开原对话准备草稿' : '重新提出'}
              </button>
            </div>
            {command.error && (
              <p role="alert" className="live-review-error">
                {command.error}
              </p>
            )}
          </section>
        )}
        {reconciliation.isError && <p role="alert">{errorMessage(reconciliation.error)}</p>}
        {(conflict || query.isError) && (
          <div className="live-review-warning" role="alert">
            <p>
              {query.isError
                ? errorMessage(query.error)
                : '提案或相关记录已变化，请刷新后重新核对。'}
            </p>
            <button
              type="button"
              className="live-review-link"
              disabled={query.isFetching}
              onClick={() =>
                void query.refetch().then((result) => {
                  if (result.isSuccess) setConflict(false);
                })
              }
            >
              刷新提案
            </button>
          </div>
        )}
      </div>
      {proposal.status === 'proposed' && (
        <footer className="live-review-footer">
          <div className="live-review-actions">
            <button
              className="live-review-primary"
              type="button"
              disabled={!mayDecide}
              onClick={() => decide('approved')}
            >
              批准本地测试
            </button>
            <button
              className="live-review-neutral"
              type="button"
              disabled={!mayDecide}
              onClick={() => decide('rejected')}
            >
              拒绝
            </button>
          </div>
          {command.error && (
            <p className="live-review-error" role="alert">
              {command.error}
            </p>
          )}
        </footer>
      )}
    </article>
  );
}
