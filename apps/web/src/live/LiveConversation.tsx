import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type SetStateAction,
} from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { PermissionMode } from '@cert-board/shared';
import { api, errorMessage, type ConversationDetail } from './api.js';
import { ApprovalCard, useBrowserCommand } from './ApprovalCard.js';
import type { LiveMessage, LiveRun } from './events.js';
import type { useConversationStream } from './useConversationStream.js';
import { ChatBubble } from './ChatBubble.js';
import { InlineExecution } from './InlineExecution.js';
import { runStateNames } from './RunDetails.js';
import { ShellIcon } from './ShellIcon.js';
import { ConversationComposer } from './ConversationComposer.js';
import { proposalStatusLabels } from './ProposalCard.js';
import {
  LinkedVerificationHistoryActions,
  LinkedVerificationRows,
  useLinkedVerifications,
} from './LinkedVerifications.js';
import './conversation.css';

const planStates = { pending: '待处理', running: '进行中', completed: '完成' };
const agentNames = { registration: '注册 Agent', maintenance: '维护 Agent' };

function RunProgress({ run, active }: { run: LiveRun | undefined; active: boolean }) {
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  if (!run)
    return active ? (
      <p className="live-conversation-meta" role="status">
        {runStateNames.queued}
      </p>
    ) : null;
  const date = Date.parse(run.startedAt);
  const elapsed = Math.max(
    0,
    Math.floor(
      ((active ? Math.max(clock, Date.parse(run.updatedAt)) : Date.parse(run.updatedAt)) - date) /
        1000,
    ),
  );
  const plan = run.plan;
  const stopped = run.status === 'stopped' || run.status === 'budget_exhausted';
  const running = plan?.steps.findIndex((step) => step.status === 'running') ?? -1;
  const complete = plan?.steps.filter((step) => step.status === 'completed').length ?? 0;
  const summary = active
    ? (run.tools.findLast((step) => step.status === 'running')?.summary ?? run.summary)
    : run.summary;
  const showSummary = summary !== '运行状态已更新。' && (!plan || summary !== plan.progress);
  return (
    <div className="live-run-progress">
      <p className="live-conversation-meta">
        <span role="status">{runStateNames[run.status]}</span> · 已用 {Math.floor(elapsed / 60)} 分{' '}
        {elapsed % 60} 秒
        {run.pendingSteeringCount > 0 && ` · ${run.pendingSteeringCount} 条插话尚未处理`}
      </p>
      {showSummary && <p className="live-conversation-meta">{summary}</p>}
      {plan && (
        <details className="live-plan" open>
          <summary>
            {running >= 0
              ? `${stopped ? '停在第' : '第'} ${running + 1} 步，共 ${plan.steps.length} 步`
              : `已完成 ${complete}/${plan.steps.length} 步`}
            {plan.progress && ` · ${plan.progress}`}
          </summary>
          <ol>
            {plan.steps.map((step, index) => (
              <li key={index}>
                {step.title}{' '}
                <span className="live-conversation-meta">
                  ·{' '}
                  {stopped && step.status === 'running' ? '停止时进行中' : planStates[step.status]}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

type ConversationProps = {
  conversationId: string;
  stream: ReturnType<typeof useConversationStream>;
  text: string;
  setText: (update: SetStateAction<string>) => void;
  onReview?: (id: string) => void;
  proposalNoticeKey?: string;
  onProposal?: (id: string) => void;
  onVerification?: (id: string) => void;
};

export function LiveConversation(props: ConversationProps) {
  return <ConversationView key={props.conversationId} {...props} />;
}

function ConversationView({
  conversationId,
  stream,
  text,
  setText,
  onReview,
  proposalNoticeKey = '',
  onProposal,
  onVerification,
}: ConversationProps) {
  const linked = useLinkedVerifications(onVerification ? conversationId : null);
  const detail = useQuery({
    queryKey: ['live', 'conversation', conversationId],
    queryFn: ({ signal }) => api.conversation(conversationId, signal),
    retry: false,
  });
  const proposals = useInfiniteQuery({
    queryKey: ['live', 'conversation-proposals', conversationId],
    queryFn: ({ pageParam, signal }) =>
      api.conversationProposals(
        conversationId,
        { limit: 50, ...(pageParam ? { cursor: pageParam } : {}) },
        signal,
      ),
    enabled: !!onProposal && !!detail.data?.projectId,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
  });
  const noticeRefresh = useRef({ key: proposalNoticeKey, pending: false });
  const refreshProposals = proposals.refetch;
  useEffect(() => {
    if (noticeRefresh.current.key !== proposalNoticeKey)
      noticeRefresh.current = { key: proposalNoticeKey, pending: true };
    if (
      !noticeRefresh.current.pending ||
      proposals.fetchStatus !== 'idle' ||
      !onProposal ||
      !detail.data?.projectId
    )
      return;
    noticeRefresh.current.pending = false;
    void refreshProposals({ cancelRefetch: false });
  }, [
    proposalNoticeKey,
    proposals.fetchStatus,
    onProposal,
    detail.data?.projectId,
    refreshProposals,
  ]);
  const { state } = stream;
  const messagesByRun = useMemo(() => {
    const groups = new Map<string, LiveMessage[]>();
    for (const message of state.messages) {
      const group = groups.get(message.runId);
      if (group) group.push(message);
      else groups.set(message.runId, [message]);
    }
    return groups;
  }, [state.messages]);
  const command = useBrowserCommand();
  const stopCommand = useBrowserCommand();
  const [queuedRun, setQueuedRun] = useState<string | null>(null);
  const [stoppedRun, setStoppedRun] = useState<string | null>(null);
  const [modeReceipt, setModeReceipt] = useState<{
    permissionMode: PermissionMode;
    version: number;
  } | null>(null);
  const feed = useRef<HTMLDivElement>(null);
  const stayAtEnd = useRef(true);
  useEffect(() => {
    const node = feed.current;
    if (node && stayAtEnd.current) node.scrollTop = node.scrollHeight;
  }, [state.lastSeq]);
  const record = detail.data;
  if (!record)
    return (
      <div className="live-conversation-loading">
        {detail.isError ? (
          <>
            <p role="alert">{errorMessage(detail.error)}</p>
            <button type="button" onClick={() => void detail.refetch()}>
              重试
            </button>
          </>
        ) : (
          <p role="status">正在读取对话…</p>
        )}
      </div>
    );

  const runId =
    queuedRun && !state.runs[queuedRun] ? queuedRun : (state.currentRunId ?? record.currentRunId);
  const observedRun = runId ? state.runs[runId] : undefined;
  const run =
    observedRun &&
    runId === stoppedRun &&
    (['queued', 'running'].includes(observedRun.status) || observedRun.verificationRoomId)
      ? {
          ...observedRun,
          status: 'stopped' as const,
          summary: '已收到停止回执，正在同步执行记录。',
        }
      : observedRun;
  const active =
    !!runId &&
    runId !== stoppedRun &&
    (!run ||
      run.status === 'queued' ||
      run.status === 'running' ||
      (run.status === 'waiting' && !!run.verificationRoomId));
  const mode = latestPermission(record, state.permissionMode, state.permissionVersion, modeReceipt);
  const connected = stream.connection === 'open' && state.lastSeq >= record.lastEventSeq;
  const mayWrite = record.canWrite && connected && !command.busy && !stopCommand.busy;
  const question = run?.question;
  const blocked = !!run?.approvalId || (!!question && !question.questionId);
  const emptyText = record.canWrite
    ? '可以提问，或说明希望 Agent 完成的工作。'
    : '此对话还没有消息。';

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (!value || !mayWrite || blocked) return;
    const answer = question?.questionId && {
      runId: question.runId,
      questionId: question.questionId,
    };
    const result = await command.run(
      [answer ? question?.questionId : 'message', value],
      (requestKey) =>
        answer
          ? api.answer(conversationId, { ...answer, text: value, requestKey })
          : api.send(conversationId, { text: value, requestKey }),
    );
    if (result) {
      setText((current) => (current.trim() === value ? '' : current));
      setQueuedRun(result.runId);
      stayAtEnd.current = true;
      const node = feed.current;
      if (node) node.scrollTop = node.scrollHeight;
    }
  }

  return (
    <section className="live-conversation" aria-label="项目对话">
      <header className="live-conversation-header">
        <p className="live-conversation-meta">
          {agentNames[record.agentCode]} · {record.ownerName}
        </p>
      </header>
      <div
        className="live-transcript"
        ref={feed}
        onScroll={(event) => {
          const node = event.currentTarget;
          stayAtEnd.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}
      >
        <div className="live-transcript-inner">
          {stream.error && (
            <div className="live-conversation-notice" role="status">
              {stream.error}{' '}
              <button type="button" onClick={stream.reconnect}>
                重新连接
              </button>
            </div>
          )}
          {!state.messages.length && !active && (
            <p className="live-empty-chat">{connected ? emptyText : '正在读取对话记录…'}</p>
          )}
          {state.runOrder.map((id) => {
            const entry = state.runs[id];
            if (!entry) return null;
            const reviewId = entry.reviewId;
            const messages = messagesByRun.get(id) ?? [];
            const processIndex = messages.findIndex(
              (message) => message.seq > (entry.tools[0]?.seq ?? Infinity),
            );
            return (
              <div key={id} className="live-turn">
                {messages.map((message, index) => (
                  <Fragment key={message.id}>
                    {index === processIndex && <InlineExecution activities={entry.tools} />}
                    <ChatBubble
                      message={message}
                      agentName={agentNames[record.agentCode]}
                      maintenance={record.agentCode === 'maintenance'}
                    />
                  </Fragment>
                ))}
                {processIndex === -1 && <InlineExecution activities={entry.tools} />}
                {onVerification && (
                  <LinkedVerificationRows
                    items={linked.items.filter(({ room }) => room.origin?.runId === id)}
                    open={onVerification}
                  />
                )}
                {(entry.status === 'stopped' || entry.status === 'budget_exhausted') && (
                  <section className="live-stop-report" aria-label="中途停止汇报">
                    <h2>运行已停止</h2>
                    {entry.summary !== '运行状态已更新。' && <p>{entry.summary}</p>}
                    <p>
                      已记录 {entry.tools.length} 个工具步骤，其中{' '}
                      {entry.tools.filter((tool) => tool.status === 'completed').length} 个完成。
                    </p>
                  </section>
                )}
                {entry.workspaceChange && (
                  <div className="live-conversation-notice">{entry.workspaceChange.summary}</div>
                )}
                {reviewId && (
                  <div className="live-conversation-notice live-conversation-result">
                    <span>
                      <ShellIcon name="clipboard" />
                      结果已提交审核
                    </span>
                    {onReview && (
                      <button type="button" onClick={() => onReview(reviewId)}>
                        查看审核
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {onVerification && (
            <>
              <LinkedVerificationRows
                items={linked.items.filter(
                  ({ room }) => !room.origin || !state.runOrder.includes(room.origin.runId),
                )}
                open={onVerification}
              />
              <LinkedVerificationHistoryActions query={linked} />
            </>
          )}
          {onProposal &&
            proposals.data?.pages
              .flatMap((result) => result.items)
              .map((proposal) => (
                <div
                  key={proposal.id}
                  className="live-conversation-notice live-conversation-result"
                >
                  <span>
                    <ShellIcon name="mail" />
                    外发提案 · {proposalStatusLabels[proposal.status]}
                  </span>
                  <button type="button" onClick={() => onProposal(proposal.id)}>
                    查看提案
                  </button>
                </div>
              ))}
          {proposals.isError && (
            <div className="live-conversation-notice" role="status">
              {errorMessage(proposals.error)}
              <button type="button" onClick={() => void proposals.refetch()}>
                重新读取提案
              </button>
            </div>
          )}
          {proposals.hasNextPage && (
            <button
              type="button"
              className="live-text-button"
              disabled={proposals.fetchStatus !== 'idle'}
              onClick={() => void proposals.fetchNextPage({ cancelRefetch: false })}
            >
              继续读取提案
            </button>
          )}
          {question && (
            <section className="live-conversation-notice live-question" aria-label="Agent提问">
              <h2>Agent 提问</h2>
              <p>{question.question}</p>
              {record.canWrite &&
                question.questionId &&
                question.options.map((option, index) => (
                  <button
                    key={index}
                    type="button"
                    disabled={!mayWrite}
                    onClick={() => setText(option)}
                  >
                    {option}
                  </button>
                ))}
            </section>
          )}
        </div>
      </div>
      <footer className="live-composer-wrap">
        <div className="live-composer-content">
          <RunProgress key={runId} run={run} active={active} />
          {run?.approvalId && record.canWrite && (
            <ApprovalCard key={run.approvalId} approvalId={run.approvalId} disabled={!connected} />
          )}
          {record.canWrite ? (
            <ConversationComposer
              conversationId={conversationId}
              projectId={record.projectId}
              text={text}
              setText={setText}
              mode={mode.permissionMode}
              mayWrite={mayWrite}
              blocked={blocked}
              status={question ? '回复' : active ? '插话' : '发送'}
              stopBusy={stopCommand.busy}
              onSubmit={(event) => void submit(event)}
              onMode={(permissionMode) =>
                void command.run(['mode', mode.version, permissionMode], (requestKey) =>
                  api.setMode(conversationId, { permissionMode, expectedVersion: mode.version, requestKey }),
                ).then((result) => {
                  if (result) setModeReceipt(result);
                  else void detail.refetch();
                })
              }
              onStop={active && runId ? () =>
                void stopCommand.run(['stop', runId], (requestKey) =>
                  api.stop(conversationId, { runId, requestKey }),
                ).then((result) => {
                  if (result?.stopped) setStoppedRun(result.runId);
                })
              : undefined}
            />
          ) : (
            <p className="live-conversation-meta">
              {record.status === 'archived'
                ? '此对话已归档，可以查看历史记录。'
                : '此对话由同部门成员发起，你可以查看。'}
            </p>
          )}
          {command.error && (
            <p className="live-command-error" role="alert">
              {command.error}
            </p>
          )}
          {stopCommand.error && (
            <p className="live-command-error" role="alert">
              {stopCommand.error}
            </p>
          )}
        </div>
      </footer>
    </section>
  );
}

function latestPermission(
  record: ConversationDetail,
  mode: PermissionMode | null,
  version: number | null,
  receipt: { permissionMode: PermissionMode; version: number } | null,
) {
  const observed =
    mode && version !== null && version >= record.permissionVersion
      ? { permissionMode: mode, version }
      : { permissionMode: record.permissionMode, version: record.permissionVersion };
  return receipt && receipt.version > observed.version ? receipt : observed;
}
