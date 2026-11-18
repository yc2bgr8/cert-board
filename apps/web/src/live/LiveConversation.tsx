import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { permissionModeSchema, type PermissionMode } from '@cert-board/shared';
import { SafeMarkdown } from '../SafeMarkdown.js';
import { api, errorMessage, type ConversationDetail } from './api.js';
import { ApprovalCard, useBrowserCommand } from './ApprovalCard.js';
import type { LiveMessage, LiveRun } from './events.js';
import { useConversationStream } from './useConversationStream.js';
import './conversation.css';

const modes: Record<PermissionMode, { label: string; description: string }> = {
  read_only: { label: '只读', description: '可以读取和分析资料，不能执行业务改动。' },
  ask: { label: '请求批准', description: '需要批准的动作先交给本对话发起人确认。' },
  full: { label: '完全允许', description: '允许执行可撤销的动作；对外动作仍需批准。' },
};
const statuses: Record<LiveRun['status'], string> = {
  queued: '等待开始',
  running: '正在处理',
  waiting: '等待处理',
  completed: '已完成',
  failed: '运行失败',
  stopped: '已停止',
  budget_exhausted: '预算检查已停止本轮',
};
const toolStates = {
  running: '进行中',
  completed: '完成',
  failed: '失败',
  awaiting_approval: '待批准',
};
const planStates = { pending: '待处理', running: '进行中', completed: '完成' };
const agentNames = { registration: '注册 Agent', maintenance: '维护 Agent' };

function ToolProcess({ run }: { run: LiveRun }) {
  if (!run.tools.length) return null;
  return (
    <details className="live-tool-process">
      <summary>
        工具过程 <span className="live-conversation-meta">{run.tools.length} 项</span>
      </summary>
      <ol>
        {run.tools.map((tool) => (
          <li key={tool.id}>
            <span className="live-conversation-meta">{toolStates[tool.status]}</span>{' '}
            {tool.summary || tool.name}
          </li>
        ))}
      </ol>
    </details>
  );
}

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
        {statuses.queued}
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
  const running = plan?.steps.findIndex((step) => step.status === 'running') ?? -1;
  const complete = plan?.steps.filter((step) => step.status === 'completed').length ?? 0;
  const summary = active
    ? (run.tools.findLast((step) => step.status === 'running')?.summary ?? run.summary)
    : run.summary;
  const showSummary = summary !== '运行状态已更新。' && (!plan || summary !== plan.progress);
  return (
    <div className="live-run-progress">
      <p className="live-conversation-meta">
        <span role="status">{statuses[run.status]}</span> · 已用 {Math.floor(elapsed / 60)} 分{' '}
        {elapsed % 60} 秒
        {run.pendingSteeringCount > 0 && ` · ${run.pendingSteeringCount} 条插话尚未处理`}
      </p>
      {showSummary && <p className="live-conversation-meta">{summary}</p>}
      {plan && (
        <details className="live-plan">
          <summary>
            {running >= 0
              ? `第 ${running + 1} 步，共 ${plan.steps.length} 步`
              : `已完成 ${complete}/${plan.steps.length} 步`}
            {plan.progress && ` · ${plan.progress}`}
          </summary>
          <ol>
            {plan.steps.map((step, index) => (
              <li key={index}>
                {step.title}{' '}
                <span className="live-conversation-meta">· {planStates[step.status]}</span>
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
  onReview?: (id: string) => void;
};

export function LiveConversation(props: ConversationProps) {
  return <ConversationView key={props.conversationId} {...props} />;
}

function ConversationView({ conversationId, onReview }: ConversationProps) {
  const detail = useQuery({
    queryKey: ['live', 'conversation', conversationId],
    queryFn: ({ signal }) => api.conversation(conversationId, signal),
    retry: false,
  });
  const stream = useConversationStream(conversationId, !!detail.data);
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
  const [text, setText] = useState('');
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
    observedRun && runId === stoppedRun && ['queued', 'running'].includes(observedRun.status)
      ? {
          ...observedRun,
          status: 'stopped' as const,
          summary: '已收到停止回执，正在同步执行记录。',
        }
      : observedRun;
  const active =
    !!runId &&
    runId !== stoppedRun &&
    (!run || run.status === 'queued' || run.status === 'running');
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
                    {index === processIndex && <ToolProcess run={entry} />}
                    {message.role === 'assistant' ? (
                      <article className="live-agent-message">
                        <SafeMarkdown>{message.text}</SafeMarkdown>
                      </article>
                    ) : (
                      <p className="live-user-message">{message.text}</p>
                    )}
                  </Fragment>
                ))}
                {processIndex === -1 && <ToolProcess run={entry} />}
                {entry.workspaceChange && (
                  <div className="live-conversation-notice">{entry.workspaceChange.summary}</div>
                )}
                {reviewId && (
                  <div className="live-conversation-notice">
                    <span>结果已提交审核</span>
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
          {run?.approvalId && record.canWrite && (
            <ApprovalCard key={run.approvalId} approvalId={run.approvalId} disabled={!connected} />
          )}
        </div>
      </div>
      <footer className="live-composer-wrap">
        <div className="live-composer-content">
          <RunProgress key={runId} run={run} active={active} />
          {record.canWrite ? (
            <form className="live-composer" onSubmit={(event) => void submit(event)}>
              <textarea
                aria-label="消息"
                maxLength={8000}
                rows={2}
                value={text}
                placeholder={
                  question ? '回复 Agent 的提问…' : blocked ? '请先处理批准请求' : '输入消息…'
                }
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing &&
                    event.keyCode !== 229
                  ) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                disabled={blocked}
              />
              <div className="live-composer-controls">
                <div className="live-permission">
                  <select
                    aria-label="权限模式"
                    aria-describedby="live-permission-help"
                    value={mode.permissionMode}
                    disabled={!mayWrite}
                    onChange={(event) => {
                      const permissionMode = permissionModeSchema.parse(event.target.value);
                      void command
                        .run(['mode', mode.version, permissionMode], (requestKey) =>
                          api.setMode(conversationId, {
                            permissionMode,
                            expectedVersion: mode.version,
                            requestKey,
                          }),
                        )
                        .then((result) => {
                          if (result) setModeReceipt(result);
                          else void detail.refetch();
                        });
                    }}
                  >
                    {Object.entries(modes).map(([value, { label }]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <span id="live-permission-help" className="live-conversation-meta">
                    {modes[mode.permissionMode].description}
                  </span>
                </div>
                <div className="live-composer-actions">
                  {active && runId && (
                    <button
                      type="button"
                      disabled={stopCommand.busy}
                      onClick={() =>
                        void stopCommand
                          .run(['stop', runId], (requestKey) =>
                            api.stop(conversationId, { runId, requestKey }),
                          )
                          .then((result) => {
                            if (result?.stopped) setStoppedRun(result.runId);
                          })
                      }
                    >
                      停止
                    </button>
                  )}
                  <button
                    type="submit"
                    className="live-send"
                    disabled={!mayWrite || !text.trim() || blocked}
                  >
                    {question ? '回复' : active ? '插话' : '发送'}
                  </button>
                </div>
              </div>
            </form>
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
