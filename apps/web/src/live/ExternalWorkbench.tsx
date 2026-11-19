import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ExternalModelExchange, ProjectRecord } from '@cert-board/shared';
import { api, errorMessage } from './api.js';
import { useBrowserCommand } from './ApprovalCard.js';
import { ShellIcon } from './ShellIcon.js';
import './external-model.css';

type Attachment = { versionId: string; path: string };
const amount = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 7 });
export const formatExternalUsd = (nano: string) => amount.format(Number(nano) / 1_000_000_000);
const setupKey = (userId: string) => ['live', 'external-model-setup', userId];
export const useExternalModelSetup = (userId: string) =>
  useQuery({
    queryKey: setupKey(userId),
    queryFn: ({ signal }) => api.externalSetup(signal),
    retry: false,
  });

function SentPreview({ exchange, userId }: { exchange: ExternalModelExchange; userId: string }) {
  const [open, setOpen] = useState(false);
  const archive = useQuery({
    queryKey: ['live', 'external-model-archive', userId, exchange.id],
    queryFn: ({ signal }) => api.externalArchive(exchange.id, signal),
    enabled: open,
    retry: false,
  });
  return (
    <details className="external-sent" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>查看出网内容</summary>
      {archive.data && <pre>{JSON.stringify(archive.data.sent, null, 2)}</pre>}
      {archive.isError && <p role="alert">{errorMessage(archive.error)}</p>}
      {open && archive.isPending && <p role="status">正在读取存档…</p>}
    </details>
  );
}

function ProjectChoice({
  projects,
  value,
  onChange,
  label,
}: {
  projects: readonly ProjectRecord[];
  value: string;
  onChange(id: string): void;
  label: string;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">选择项目</option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function AttachmentPicker({
  projects,
  userId,
  onAttach,
  onClose,
}: {
  projects: readonly ProjectRecord[];
  userId: string;
  onAttach(attachment: Attachment): void;
  onClose(): void;
}) {
  const [projectId, setProjectId] = useState('');
  const workspace = useQuery({
    queryKey: ['live', 'workspace', userId, projectId],
    queryFn: ({ signal }) => api.workspace(projectId, signal),
    enabled: !!projectId,
    retry: false,
  });
  const current = workspace.data;
  const files = useQuery({
    queryKey: ['live', 'external-attachments', userId, current?.id, current?.currentVersionId],
    queryFn: ({ signal }) =>
      api.workspaceFiles(current!.id, { versionId: current!.currentVersionId, limit: 50 }, signal),
    enabled: !!current,
    retry: false,
  });
  return (
    <section className="external-picker" aria-label="选择外部模型附件">
      <ProjectChoice
        projects={projects}
        value={projectId}
        onChange={setProjectId}
        label="附件所属项目"
      />
      {(workspace.isError || files.isError) && (
        <p role="alert">{errorMessage(workspace.error ?? files.error)}</p>
      )}
      {current &&
        files.data?.items
          .filter(
            (file) =>
              file.mediaType.toLowerCase().startsWith('text/') && file.dataLevel !== 'confidential',
          )
          .map((file) => (
            <button
              key={file.path}
              type="button"
              className="live-text-button"
              onClick={() => onAttach({ versionId: current.currentVersionId, path: file.path })}
            >
              {file.path}
            </button>
          ))}
      <button type="button" className="live-secondary" onClick={onClose}>
        关闭附件选择
      </button>
    </section>
  );
}

function SharePicker({
  exchange,
  projects,
  userId,
  onClose,
}: {
  exchange: ExternalModelExchange;
  projects: readonly ProjectRecord[];
  userId: string;
  onClose(): void;
}) {
  const [projectId, setProjectId] = useState('');
  const [conversationId, setConversationId] = useState('');
  const [sent, setSent] = useState(false);
  const command = useBrowserCommand();
  const client = useQueryClient();
  const conversations = useQuery({
    queryKey: ['live', 'external-share-targets', userId, projectId],
    queryFn: ({ signal }) => api.conversations({ projectId, scope: 'all', limit: 50 }, signal),
    enabled: !!projectId,
    retry: false,
  });
  return (
    <section className="external-picker" aria-label="发给 Agent">
      <ProjectChoice
        projects={projects}
        value={projectId}
        onChange={(id) => {
          setProjectId(id);
          setConversationId('');
        }}
        label="目标项目"
      />
      <label>
        目标对话
        <select
          value={conversationId}
          onChange={(event) => setConversationId(event.target.value)}
          disabled={!projectId || sent}
        >
          <option value="">选择对话</option>
          {conversations.data?.items
            .filter((item) => item.canWrite)
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
        </select>
      </label>
      <div className="external-actions">
        <button
          type="button"
          className="live-primary"
          disabled={!conversationId || command.busy || sent}
          onClick={() => {
            void command
              .run([exchange.id, conversationId], (requestKey) =>
                api.externalShare(exchange.id, { conversationId, requestKey }),
              )
              .then((result) => {
                if (!result) return;
                setSent(true);
                void client.invalidateQueries({ queryKey: ['live', 'conversations', userId] });
              });
          }}
        >
          发送引用
        </button>
        <button type="button" className="live-secondary" onClick={onClose}>
          关闭引用选择
        </button>
      </div>
      {sent && <p role="status">引用已交给目标对话。</p>}
      {(command.error || conversations.isError) && (
        <p role="alert">{command.error ?? errorMessage(conversations.error)}</p>
      )}
    </section>
  );
}

function ExternalTurn({
  exchange,
  userId,
  projects,
  modelLabel,
}: {
  exchange: ExternalModelExchange;
  userId: string;
  projects: readonly ProjectRecord[];
  modelLabel: string;
}) {
  const [sharing, setSharing] = useState(false);
  return (
    <article className="external-turn">
      <div className="external-user-message">
        <p>{exchange.originalText}</p>
        <div className="external-actions">
          {exchange.replacementCount > 0 && (
            <span className="live-muted">已替换 {exchange.replacementCount} 处保密信息</span>
          )}
          <SentPreview exchange={exchange} userId={userId} />
        </div>
      </div>
      {exchange.answer !== null ? (
        <div className="external-answer">
          <header className="external-actions external-answer-label">
            <ShellIcon name="sparkle" />
            <strong>{modelLabel}</strong>
            {exchange.search && <span className="live-notice-chip">联网搜索</span>}
          </header>
          <p>{exchange.answer}</p>
          {exchange.references.length > 0 && (
            <ul className="external-citations" aria-label="外部来源">
              {exchange.references.map((reference, index) => (
                <li key={`${reference.url}:${index}`}>
                  <a href={reference.url} target="_blank" rel="noopener noreferrer">
                    {reference.title}
                  </a>
                </li>
              ))}
            </ul>
          )}
          <div className="external-actions">
            <button
              type="button"
              className="live-secondary"
              aria-expanded={sharing}
              onClick={() => setSharing(!sharing)}
            >
              发给 Agent
            </button>
            {exchange.costNano && (
              <span className="live-muted">本次 {formatExternalUsd(exchange.costNano)} 美元</span>
            )}
          </div>
          {sharing && (
            <SharePicker
              exchange={exchange}
              projects={projects}
              userId={userId}
              onClose={() => setSharing(false)}
            />
          )}
        </div>
      ) : (
        <p className="live-muted" role="status">
          {
            {
              reserved: '正在处理…',
              unknown: '费用待核对，预占已保留。',
              not_sent: '出网检查未通过，本次未发送。',
              settled: '正在读取回答…',
            }[exchange.status]
          }
        </p>
      )}
    </article>
  );
}

export function ExternalWorkbench({
  userId,
  conversationId,
  onCreated,
  projects,
}: {
  userId: string;
  conversationId: string | null;
  onCreated(id: string): void;
  projects: readonly ProjectRecord[];
}) {
  const client = useQueryClient();
  const setup = useExternalModelSetup(userId);
  const command = useBrowserCommand();
  const [text, setText] = useState('');
  const [chosenModel, setChosenModel] = useState('');
  const [searchOverride, setSearchOverride] = useState<boolean | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const messagesKey = ['live', 'external-model-messages', userId, conversationId];
  const history = useQuery({
    queryKey: messagesKey,
    queryFn: ({ signal }) => api.externalMessages(conversationId!, signal),
    enabled: !!conversationId,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.some((item) => item.status === 'reserved') ? 1000 : false,
  });
  const search = searchOverride ?? history.data?.at(-1)?.search ?? true;
  useEffect(() => {
    const node = transcript.current;
    if (node && follow.current) node.scrollTop = node.scrollHeight;
  }, [history.data]);
  const models = setup.data?.models ?? [];
  const model = models.find(({ id }) => id === chosenModel)?.id ?? models[0]?.id ?? '';
  const budget = setup.data?.budget;
  const pending = history.data?.some((item) => item.status === 'reserved') ?? false;
  const ready = !!model && !!budget && !budget.blocked && !pending && !command.busy;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = text.trim();
    if (!ready || !value) return;
    const result = await command.run(
      [conversationId, model, value, search, attachments],
      async (requestKey) => {
        const id =
          conversationId ??
          (
            await api.externalCreate({
              title: value.replace(/\s+/gu, ' ').slice(0, 60),
              requestKey,
            })
          ).id;
        return api.externalSend(id, { requestKey, model, text: value, search, attachments });
      },
    );
    if (!result) return;
    setText((current) => (current.trim() === value ? '' : current));
    setAttachments([]);
    setAttaching(false);
    if (!conversationId) onCreated(result.conversationId);
    void client.invalidateQueries({ queryKey: ['live', 'external-model-messages', userId] });
    void client.invalidateQueries({ queryKey: ['live', 'external-model-conversations', userId] });
    void client.invalidateQueries({ queryKey: setupKey(userId) });
  }
  return (
    <section className="external-workbench" aria-label="外部模型对话">
      <div
        className="external-transcript"
        ref={transcript}
        onScroll={(event) => {
          const node = event.currentTarget;
          follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}
      >
        <div className="external-content">
          {setup.data?.readiness === 'pending_local_policy' && (
            <p className="external-notice" role="status">
              本地出网检查及服务商策略尚未就绪。
            </p>
          )}
          {setup.data?.readiness === 'fixture' && !history.data?.length && (
            <p className="external-notice">剧本模型</p>
          )}
          {(setup.isError || history.isError) && (
            <p role="alert">{errorMessage(setup.error ?? history.error)}</p>
          )}
          {history.data?.map((exchange) => (
            <ExternalTurn
              key={exchange.id}
              exchange={exchange}
              userId={userId}
              projects={projects}
              modelLabel={
                models.find((profile) => profile.id === exchange.model)?.label ?? exchange.model
              }
            />
          ))}
        </div>
      </div>
      <footer className="external-dock">
        <form
          className="external-content external-composer"
          onSubmit={(event) => void submit(event)}
        >
          <textarea
            rows={2}
            aria-label="外部模型消息"
            value={text}
            maxLength={8000}
            placeholder="向外部模型提问…"
            onChange={(event) => setText(event.target.value)}
          />
          {attachments.length > 0 && (
            <ul className="external-citations" aria-label="当前附件">
              {attachments.map((item) => (
                <li key={`${item.versionId}:${item.path}`}>
                  <button
                    type="button"
                    className="live-secondary"
                    aria-label={`移除附件 ${item.path}`}
                    onClick={() =>
                      setAttachments((current) => current.filter((entry) => entry !== item))
                    }
                  >
                    {item.path} ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="external-actions external-composer-actions">
            <button
              className="live-icon-button"
              type="button"
              aria-label="添加附件"
              aria-expanded={attaching}
              disabled={attachments.length >= 3 || command.busy}
              onClick={() => setAttaching(!attaching)}
            >
              <ShellIcon name="attachment" />
            </button>
            <select
              aria-label="外部模型选择"
              value={model}
              disabled={!models.length || command.busy}
              onChange={(event) => setChosenModel(event.target.value)}
            >
              {!models.length && <option value="">暂无可用模型</option>}
              {models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <label className="external-search">
              <input
                type="checkbox"
                checked={search}
                disabled={command.busy}
                onChange={(event) => setSearchOverride(event.target.checked)}
              />
              联网搜索
            </label>
            {budget && (
              <span className="external-budget live-muted">
                本月 {formatExternalUsd(budget.usedNano)} / {formatExternalUsd(budget.limitNano)}{' '}
                美元
              </span>
            )}
            <button
              className="external-send"
              aria-label="发送给外部模型"
              type="submit"
              disabled={!ready || !text.trim()}
            >
              <ShellIcon name="arrowUp" />
            </button>
          </div>
          {attaching && (
            <AttachmentPicker
              projects={projects}
              userId={userId}
              onClose={() => setAttaching(false)}
              onAttach={(item) => {
                setAttachments((current) =>
                  current.some(
                    ({ path, versionId }) => path === item.path && versionId === item.versionId,
                  )
                    ? current
                    : [...current, item],
                );
                setAttaching(false);
              }}
            />
          )}
          {budget?.blocked && (
            <p role="status" className="external-notice">
              外部模型预算已暂停。
            </p>
          )}
          {command.error && (
            <p role="alert" className="live-error">
              {command.error}
            </p>
          )}
        </form>
      </footer>
    </section>
  );
}
