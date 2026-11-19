import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProjectRecord,
  VerificationConclusion,
  VerificationDetail,
  VerificationMessage,
  VerificationModel,
} from '@cert-board/shared';
import { api, errorMessage } from './api.js';
import { useBrowserCommand } from './ApprovalCard.js';
import { ShellIcon } from './ShellIcon.js';
import './verification.css';

export const verificationSettingsKey = (userId: string) => [
  'live',
  'verification-settings',
  userId,
];
export function useVerificationSettings(userId: string) {
  return useQuery({
    queryKey: verificationSettingsKey(userId),
    queryFn: ({ signal }) => api.verificationSettings(signal),
    retry: false,
  });
}
export const verificationRoomKey = (userId: string, roomId: string | null) => [
  'live',
  'verification-room',
  userId,
  roomId,
];
const stageLabels = { discussing: '进行中', completed: '已整理结论', paused: '已暂停' };
const claimLabels = {
  trusted: '可信',
  disputed: '有分歧',
  unverified: '待核实',
  human: '人工提供',
};
const times = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const hostLabel = (host: 'registration' | 'maintenance') =>
  host === 'maintenance' ? '维护Agent' : '注册Agent';
const channelLabel = (channel: VerificationModel['channel']) =>
  channel === 'cursor' ? 'Cursor' : '模型网关';

function SentContent({
  archiveId,
  userId,
  count,
}: {
  archiveId: string;
  userId: string;
  count: number;
}) {
  const [open, setOpen] = useState(false);
  const archive = useQuery({
    queryKey: ['live', 'external-model-archive', userId, archiveId],
    queryFn: ({ signal }) => api.externalArchive(archiveId, signal),
    enabled: open,
    retry: false,
  });
  return (
    <details className="verification-sent" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        {count > 0 ? `发送前已自动替换 ${count} 处保密信息 · ` : ''}查看实际发出的内容
      </summary>
      {archive.data && <pre>{JSON.stringify(archive.data.sent, null, 2)}</pre>}
      {archive.isError && <p role="alert">{errorMessage(archive.error)}</p>}
    </details>
  );
}

function Post({ message, userId }: { message: VerificationMessage; userId: string }) {
  if (message.type === 'system' || message.type === 'summary')
    return (
      <article id={`verification-post-${message.id}`} className="verification-system" tabIndex={-1}>
        {message.type === 'summary' ? '主持人摘要 · ' : ''}
        {message.text}
      </article>
    );
  const human = message.type === 'human';
  return (
    <article
      id={`verification-post-${message.id}`}
      className={`verification-post ${human ? 'verification-person' : ''}`}
      tabIndex={-1}
    >
      <header>
        <span
          className={`verification-avatar ${message.model?.startsWith('claude') ? 'verification-claude' : ''}`}
        >
          {message.author.at(0)}
        </span>
        <strong>{message.author}</strong>
        {message.type === 'host' && <span className="verification-badge host">主持人</span>}
        {message.channel && <span>经 {channelLabel(message.channel)}</span>}
        {message.round && <span className="verification-badge">第{message.round}轮</span>}
        <time dateTime={message.createdAt}>{times.format(new Date(message.createdAt))}</time>
      </header>
      <p>{message.text}</p>
      {message.sources.length > 0 && (
        <ul className="verification-sources" aria-label="出处">
          {message.sources.map((source) => (
            <li key={source.url}>
              <a href={source.url} target="_blank" rel="noopener noreferrer" title={source.excerpt}>
                {source.title} ↗
              </a>
            </li>
          ))}
        </ul>
      )}
      {message.archiveId && (
        <SentContent archiveId={message.archiveId} userId={userId} count={message.redactions} />
      )}
    </article>
  );
}

function Conclusion({
  conclusion,
  close,
  jump,
  onShare,
  sharing,
}: {
  conclusion: VerificationConclusion;
  close(): void;
  jump(id: string): void;
  onShare(): void;
  sharing: boolean;
}) {
  return (
    <aside className="verification-aside verification-conclusion" aria-label="核实结论">
      <header>
        <strong>结论</strong>
        <button
          type="button"
          className="live-icon-button"
          aria-label="关闭核实右栏"
          onClick={close}
        >
          ×
        </button>
      </header>
      <div className="verification-aside-content">
        <h3>{conclusion.summary}</h3>
        {Object.entries(claimLabels).map(([category, label]) => {
          const items = conclusion.items.filter((item) => item.category === category);
          if (!items.length) return null;
          return (
            <section key={category} className="verification-claim-section">
              <h4>
                <span className={`verification-badge ${category}`}>
                  {label} {items.length}
                </span>
              </h4>
              {items.map((item, index) => (
                <article className="verification-claim" key={`${item.statement}:${index}`}>
                  <p>{item.statement}</p>
                  {item.selection && <p className="live-muted">主持人的取舍 · {item.selection}</p>}
                  <ul>
                    {item.evidence.map((evidence) => (
                      <li key={evidence.messageId}>
                        <button
                          type="button"
                          className="live-text-button"
                          onClick={() => jump(evidence.messageId)}
                        >
                          {evidence.author}的发言
                        </button>
                        {item.category === 'disputed' && <span>{evidence.statement}</span>}
                        {evidence.sources.map((source) => (
                          <a
                            key={source.url}
                            href={source.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {source.title}
                          </a>
                        ))}
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </section>
          );
        })}
      </div>
      <footer>
        <button className="live-secondary" type="button" onClick={onShare} aria-expanded={sharing}>
          发给 Agent
        </button>
      </footer>
    </aside>
  );
}

function VerificationMembers({
  data,
  messages,
  onClose,
  userId,
}: {
  data: VerificationDetail;
  messages: VerificationMessage[];
  onClose(): void;
  userId: string;
}) {
  const settings = useVerificationSettings(userId);
  const client = useQueryClient();
  const command = useBrowserCommand();
  const [invite, setInvite] = useState('');
  const { room, participants } = data;
  const remaining =
    settings.data?.catalog.filter(
      (model) =>
        !participants.some(({ id }) => id === model.id) &&
        settings.data?.models.some(({ id, enabled }) => id === model.id && enabled),
    ) ?? [];
  const creators = [
    ...new Set(messages.filter(({ type }) => type === 'human').map(({ author }) => author)),
  ];
  const callCount = messages.filter(({ archiveId }) => archiveId).length;
  return (
    <aside className="verification-aside" aria-label="本场核实">
      <header>
        <strong>本场核实</strong>
        <button
          type="button"
          className="live-icon-button"
          aria-label="关闭核实右栏"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="verification-aside-content">
        <section>
          <h4>成员</h4>
          <p>
            <strong>{hostLabel(room.host)}</strong>{' '}
            <span className="verification-badge host">主持人</span>
          </p>
          {participants.map((model) => (
            <div className="verification-member" key={model.id}>
              <span className="verification-avatar">{model.label.at(0)}</span>
              <div>
                <strong>{model.label}</strong>
                <small>
                  经 {channelLabel(model.channel)} · 已回答{' '}
                  {
                    messages.filter(({ model: id, type }) => id === model.id && type === 'model')
                      .length
                  }{' '}
                  次
                </small>
              </div>
              {room.activeModel === model.id && (
                <span className="verification-badge host">回答中</span>
              )}
            </div>
          ))}
          {creators.map((name) => (
            <div className="verification-member" key={name}>
              <span className="verification-avatar">{name.at(0)}</span>
              {name}
            </div>
          ))}
          {remaining.length > 0 && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!invite) return;
                void command.run([room.id, invite], async () => {
                  await api.verificationInvite(room.id, invite);
                  await client.invalidateQueries({
                    queryKey: verificationRoomKey(userId, room.id),
                  });
                  return true;
                });
              }}
            >
              <label>
                加入一个模型{' '}
                <select value={invite} onChange={(event) => setInvite(event.target.value)}>
                  <option value="">选择模型</option>
                  {remaining.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </select>
              </label>
              <button className="live-secondary" type="submit" disabled={!invite || command.busy}>
                加入
              </button>
            </form>
          )}
          {command.error && <p role="alert">{command.error}</p>}
        </section>
        <section>
          <h4>来源</h4>
          <p>{room.startedBy} 发起</p>
          {room.projectName && <p>{room.projectName}</p>}
        </section>
        <section>
          <h4>外发</h4>
          <p>已保存 {callCount} 次请求的出网记录。展开回复可查看实际发送的内容。</p>
        </section>
        {room.stoppedBy && <p role="status">由 {room.stoppedBy} 停止并整理。</p>}
      </div>
    </aside>
  );
}

type ProjectSelection = {
  projects: readonly ProjectRecord[];
  loadMoreProjects: (() => void) | undefined;
};
function TargetProject({
  projects,
  loadMoreProjects,
  projectId,
  setProject,
}: ProjectSelection & { projectId: string; setProject(id: string): void }) {
  return (
    <div className="verification-select">
      <label>
        关联项目{' '}
        <select value={projectId} onChange={(event) => setProject(event.target.value)}>
          <option value="">不关联项目</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      {loadMoreProjects && (
        <button type="button" className="live-text-button" onClick={loadMoreProjects}>
          加载更多项目
        </button>
      )}
    </div>
  );
}

function Share({
  roomId,
  userId,
  projects,
  loadMoreProjects,
}: ProjectSelection & { roomId: string; userId: string }) {
  const [projectId, setProject] = useState('');
  const [target, setTarget] = useState('');
  const [shared, setShared] = useState(false);
  const command = useBrowserCommand();
  const conversations = useInfiniteQuery({
    queryKey: ['live', 'verification-share', userId, projectId],
    queryFn: ({ pageParam, signal }) =>
      api.conversations(
        {
          projectId,
          scope: 'all',
          limit: 50,
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: Boolean(projectId),
    retry: false,
  });
  return (
    <form
      className="verification-share"
      aria-label="把核实结论发给 Agent"
      onSubmit={(event) => {
        event.preventDefault();
        if (!target) return;
        void command
          .run([roomId, target], (requestKey) =>
            api.verificationShare(roomId, {
              conversationId: target,
              requestKey,
            }),
          )
          .then((result) => setShared(Boolean(result)));
      }}
    >
      <TargetProject
        projects={projects}
        loadMoreProjects={loadMoreProjects}
        projectId={projectId}
        setProject={(id) => {
          setProject(id);
          setTarget('');
          setShared(false);
        }}
      />
      <label>
        目标对话{' '}
        <select
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          disabled={!projectId}
        >
          <option value="">选择对话</option>
          {conversations.data?.pages
            .flatMap(({ items }) => items)
            .filter(({ canWrite }) => canWrite)
            .map((option) => (
              <option key={option.id} value={option.id}>
                {option.title}
              </option>
            ))}
        </select>
      </label>
      {conversations.hasNextPage && (
        <button
          className="live-text-button"
          type="button"
          onClick={() => void conversations.fetchNextPage()}
        >
          加载更多对话
        </button>
      )}
      <button className="live-primary" type="submit" disabled={!target || shared || command.busy}>
        发送引用
      </button>
      {shared && <p role="status">结论已发给目标对话。</p>}
      {(command.error || conversations.isError) && (
        <p role="alert">{command.error ?? errorMessage(conversations.error)}</p>
      )}
    </form>
  );
}

export function VerificationWorkbench({
  userId,
  roomId,
  projects,
  loadMoreProjects,
  onCreated,
}: ProjectSelection & { userId: string; roomId: string | null; onCreated(id: string): void }) {
  const client = useQueryClient();
  const command = useBrowserCommand();
  const stop = useBrowserCommand();
  const settings = useVerificationSettings(userId);
  const [question, setQuestion] = useState('');
  const [projectId, setProject] = useState('');
  const [mention, setMention] = useState<string | null>(null);
  const [right, setRight] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  const [jumpError, setJumpError] = useState<string | null>(null);
  const [eventStreamReady, setEventStreamReady] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const roomKey = verificationRoomKey(userId, roomId);
  const history = useInfiniteQuery({
    queryKey: roomKey,
    queryFn: ({ pageParam, signal }) => api.verificationRoom(roomId!, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: Boolean(roomId),
    retry: false,
    refetchInterval: (query) =>
      eventStreamReady
        ? false
        : query.state.data?.pages[0]?.room.status === 'discussing'
          ? 1200
          : 4000,
  });
  useEffect(() => {
    if (!roomId || !globalThis.EventSource) return;
    const source = new EventSource(`/api/verification/rooms/${encodeURIComponent(roomId)}/events`);
    const updated = () => {
      setEventStreamReady(true);
      void client.invalidateQueries({ queryKey: verificationRoomKey(userId, roomId) });
      void client.invalidateQueries({ queryKey: ['live', 'verification-rooms', userId] });
    };
    const fallback = () => setEventStreamReady(false);
    source.addEventListener('verification_updated', updated);
    source.addEventListener('error', fallback);
    return () => {
      source.removeEventListener('verification_updated', updated);
      source.removeEventListener('error', fallback);
      source.close();
    };
  }, [client, roomId, userId]);
  const data = history.data?.pages[0];
  const messages = (history.data?.pages ?? [])
    .slice()
    .reverse()
    .flatMap((page) => page.messages);
  const last = messages.at(-1)?.id;
  useEffect(() => {
    const element = scroller.current;
    if (element && follow.current && last) element.scrollTop = element.scrollHeight;
  }, [last]);
  useEffect(() => {
    if (!jumpTo) return;
    const element = document.getElementById(`verification-post-${jumpTo}`);
    if (element) {
      element.scrollIntoView({ block: 'center' });
      element.focus();
      setJumpTo(null);
      return;
    }
    if (history.isFetchingNextPage) return;
    if (history.hasNextPage)
      void history.fetchNextPage().then((result) => {
        if (result.isError) {
          setJumpTo(null);
          setJumpError('暂时无法读取更早的发言。');
        }
      });
    else {
      setJumpTo(null);
      setJumpError('未在当前记录中找到这条发言。');
    }
  }, [jumpTo, history]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = question.trim();
    if (!text) return;
    const result = await command.run([roomId, projectId, text, mention], async (requestKey) => {
      if (!roomId)
        return api.verificationCreate({ question: text, projectId: projectId || null, requestKey });
      await api.verificationPost(roomId, { text, mention, requestKey });
      return { id: roomId };
    });
    if (!result) return;
    if (mounted.current) {
      setQuestion((current) => (current.trim() === text ? '' : current));
      setMention(null);
      follow.current = true;
      if (!roomId) onCreated(result.id);
    }
    await Promise.all([
      client.invalidateQueries({ queryKey: ['live', 'verification-rooms', userId] }),
      client.invalidateQueries({ queryKey: verificationRoomKey(userId, result.id) }),
      client.invalidateQueries({ queryKey: verificationSettingsKey(userId) }),
    ]);
  }
  const room = data?.room;
  const active = data?.participants.find(({ id }) => id === room?.activeModel);
  const conclusion = room?.status === 'completed' ? data?.conclusion : null;
  return (
    <section className="verification-workbench" aria-label="外部核实群聊">
      <div className="verification-discussion">
        {room && (
          <div className="verification-toolbar">
            <span
              className={`verification-badge ${room.status === 'paused' ? 'disputed' : 'host'}`}
            >
              {stageLabels[room.status]}
            </span>
            {!right && (
              <button className="live-secondary" type="button" onClick={() => setRight(true)}>
                {conclusion ? '查看结论' : '本场核实'}
              </button>
            )}
            {room.status === 'discussing' && !room.stoppedBy && (
              <button
                className="live-secondary"
                type="button"
                disabled={stop.busy}
                onClick={() =>
                  void stop.run([room.id], async () => {
                    await api.verificationStop(room.id);
                    await client.invalidateQueries({ queryKey: roomKey });
                    return true;
                  })
                }
              >
                停止并整理
              </button>
            )}
            {conclusion && (
              <button
                className="live-text-button"
                type="button"
                onClick={() => {
                  const data = new Blob([JSON.stringify({ messages, conclusion }, null, 2)], {
                    type: 'application/json',
                  });
                  const url = URL.createObjectURL(data);
                  const link = document.createElement('a');
                  link.href = url;
                  link.download = '核实记录.json';
                  link.click();
                  setTimeout(() => URL.revokeObjectURL(url), 0);
                }}
              >
                导出已加载记录
              </button>
            )}
          </div>
        )}
        <div
          className="verification-transcript"
          ref={scroller}
          onScroll={(event) => {
            const node = event.currentTarget;
            follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
          }}
        >
          <div className="verification-content">
            {!roomId && <h2>发起核实</h2>}
            {!roomId &&
              settings.data?.channelStatus !== 'ready' &&
              settings.data?.channelStatus !== 'fixture' && (
                <p role="status">核实通道暂不可用。问题可以先保存在本机。</p>
              )}
            {settings.data?.channelStatus === 'fixture' && !roomId && <p>剧本通道</p>}
            {history.hasNextPage && (
              <button
                className="live-text-button"
                type="button"
                onClick={() => {
                  follow.current = false;
                  void history.fetchNextPage();
                }}
              >
                较早的发言
              </button>
            )}
            {history.isError && <p role="alert">{errorMessage(history.error)}</p>}
            {messages.map((message) => (
              <Post key={message.id} message={message} userId={userId} />
            ))}
            {active && (
              <p className="verification-system" role="status">
                {active.label} 正在回答…
              </p>
            )}
          </div>
        </div>
        <footer className="verification-composer-wrap">
          {sharing && room && (
            <Share
              roomId={room.id}
              userId={userId}
              projects={projects}
              loadMoreProjects={loadMoreProjects}
            />
          )}
          <form className="verification-composer" onSubmit={(event) => void submit(event)}>
            {!roomId && (
              <TargetProject
                projects={projects}
                loadMoreProjects={loadMoreProjects}
                projectId={projectId}
                setProject={setProject}
              />
            )}
            <textarea
              aria-label={roomId ? '在群里说话' : '核实问题'}
              rows={2}
              maxLength={8000}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder={roomId ? '在群里说话，@ 点名模型' : '写下要核实的问题…'}
            />
            <div className="verification-composer-actions">
              {data && room && (
                <>
                  {[
                    ...data.participants.map(({ id, label }) => ({ id, label })),
                    { id: 'host', label: '主持人' },
                  ].map((model) => (
                    <button
                      key={model.id}
                      type="button"
                      className="live-secondary"
                      aria-pressed={mention === model.id}
                      onClick={() => setMention(mention === model.id ? null : model.id)}
                    >
                      @{model.label}
                    </button>
                  ))}
                  <small>
                    {room.humanJoined ? '已有人发言' : `每个模型最多自动讨论 ${data.autoRounds} 轮`}
                  </small>
                </>
              )}
              <button
                type="submit"
                className="verification-send"
                aria-label={roomId ? '发送群聊发言' : '发起核实'}
                disabled={command.busy || !question.trim()}
              >
                {roomId ? <ShellIcon name="arrowUp" /> : '发起核实'}
              </button>
            </div>
            {(command.error || stop.error || jumpError) && (
              <p role="alert">{command.error ?? stop.error ?? jumpError}</p>
            )}
          </form>
        </footer>
      </div>
      {data &&
        right &&
        (conclusion ? (
          <Conclusion
            conclusion={conclusion}
            close={() => setRight(false)}
            jump={(id) => {
              follow.current = false;
              setJumpError(null);
              setJumpTo(id);
            }}
            onShare={() => setSharing((value) => !value)}
            sharing={sharing}
          />
        ) : (
          <VerificationMembers
            data={data}
            messages={messages}
            onClose={() => setRight(false)}
            userId={userId}
          />
        ))}
    </section>
  );
}
