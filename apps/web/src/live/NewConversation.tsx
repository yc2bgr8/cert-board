import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  defaultPermissionMode,
  type AgentCode,
  type PermissionMode,
  type ProjectRecord,
} from '@cert-board/shared';
import { api, createRequestKey, errorMessage } from './api.js';
import { ShellIcon } from './ShellIcon.js';

const modeDescriptions: Record<PermissionMode, string> = {
  read_only: '只查看资料与记录，不修改文件或业务记录。',
  ask: '可以整理工作文件；写业务记录和发内部消息前先请你批准。',
  full: '直接处理业务记录和内部消息；外部消息仍逐条批准，最终结果仍需审核。',
};
const agents = [
  {
    code: 'registration',
    name: '注册Agent',
    detail: '注册项目：立项、路径研判、申报包、发补答复',
    icon: 'clipboard',
  },
  {
    code: 'maintenance',
    name: '维护Agent',
    detail: '维护事项：证照台账、年度注册、续期、上市后监测',
    icon: 'wrench',
  },
] as const;
export function NewConversation({
  open,
  onOpenChange,
  initialProjectId,
  initialAgent,
  projects,
  userId,
  returnFocus,
  onCreated,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  initialProjectId: string | null;
  initialAgent: AgentCode;
  projects: ProjectRecord[];
  userId: string;
  returnFocus: RefObject<HTMLElement | null>;
  onCreated(conversationId: string, projectId: string | null, agentCode: AgentCode): void;
}) {
  const [projectId, setProjectId] = useState('');
  const [agentCode, setAgentCode] = useState<AgentCode>(initialAgent);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(defaultPermissionMode);
  const [goalId, setGoalId] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const projectSelect = useRef<HTMLSelectElement>(null);
  const inFlight = useRef(false);
  const completed = useRef(false);
  const intent = useRef<{ fingerprint: string; requestKey: string } | null>(null);
  const selected = projects.find((project) => project.id === projectId);
  const goalsQuery = useInfiniteQuery({
    queryKey: ['live', 'goals', userId, projectId],
    queryFn: ({ pageParam, signal }) =>
      api.goals(projectId, { limit: 50, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? (last.nextCursor ?? undefined) : undefined),
    enabled: open && Boolean(projectId),
    retry: false,
    staleTime: 15_000,
  });
  const goals =
    goalsQuery.data?.pages
      .flatMap((page) => page.items)
      .filter((goal) => goal.status === 'active') ?? [];
  const singleGoal = goals.length === 1 && !goalsQuery.hasNextPage ? goals[0]?.id : undefined;
  useEffect(() => {
    if (!open) return;
    setProjectId(initialProjectId ?? '');
    setGoalId('');
    setTitle('');
    setAgentCode(initialAgent);
    setPermissionMode(defaultPermissionMode);
    setError(null);
    intent.current = null;
    completed.current = false;
  }, [open, initialProjectId, initialAgent]);
  useEffect(() => {
    if (singleGoal && !goalId) setGoalId(singleGoal);
  }, [singleGoal, goalId]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    if (projectId && (!selected || goalsQuery.isPending || goalsQuery.isError)) {
      setError('请等待项目和目标加载完成后重试。');
      return;
    }
    if (projectId && goals.length > 0 && (!goalId || !goals.some((goal) => goal.id === goalId))) {
      setError('请选择一个有效的活动目标。');
      return;
    }
    const input = {
      permissionMode,
      agentCode: selected?.projectType ?? agentCode,
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(goalId && projectId ? { goalId } : {}),
    };
    const fingerprint = JSON.stringify({ projectId: projectId || null, input });
    if (intent.current?.fingerprint !== fingerprint)
      intent.current = { fingerprint, requestKey: createRequestKey() };
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await api.createConversation(
        { ...input, requestKey: intent.current.requestKey },
        projectId || undefined,
      );
      completed.current = true;
      onCreated(
        result.conversation.id,
        result.conversation.projectId,
        result.conversation.agentCode,
      );
      onOpenChange(false);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const selectedAgent = selected?.projectType ?? agentCode;
  return (
    <Dialog.Root
      modal={false}
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <Dialog.Content
        className="live-dialog live-new-dialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          projectSelect.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (completed.current) return;
          const trigger = returnFocus.current;
          if (trigger?.isConnected && !trigger.closest('[hidden]')) trigger.focus();
          else document.querySelector<HTMLButtonElement>('.live-project-header button')?.focus();
        }}
      >
        <Dialog.Title className="sr-only">新对话</Dialog.Title>
        <Dialog.Description className="sr-only">选择项目和本次工作的权限。</Dialog.Description>
        <Dialog.Close
          className="live-icon-button live-new-close"
          aria-label="关闭新对话"
          disabled={busy}
        >
          <ShellIcon name="close" />
        </Dialog.Close>
        <form className="live-create-form" onSubmit={(event) => void submit(event)}>
          <h2>让{selectedAgent === 'registration' ? '注册Agent' : '维护Agent'}做什么？</h2>
          <fieldset className="live-agent-options" disabled={busy || Boolean(selected)}>
            <legend className="sr-only">选择Agent</legend>
            {agents.map(({ code, name, detail, icon }) => (
              <label className="live-agent-option" key={code}>
                {selected ? null : (
                  <input
                    className="sr-only"
                    type="radio"
                    name="live-new-agent"
                    aria-label={name}
                    checked={agentCode === code}
                    onChange={() => setAgentCode(code)}
                  />
                )}
                <span
                  className={
                    selectedAgent === code ? 'live-agent-card is-selected' : 'live-agent-card'
                  }
                >
                  <span className="live-agent-symbol">
                    <ShellIcon name={icon} />
                  </span>
                  <span>
                    <strong>{name}</strong>
                    <small>{detail}</small>
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="live-create-dock">
            <label className="sr-only" htmlFor="live-new-title">
              对话标题
            </label>
            <textarea
              id="live-new-title"
              value={title}
              rows={3}
              disabled={busy}
              maxLength={255}
              placeholder="可选，简述这次工作"
              onChange={(event) => setTitle(event.target.value)}
            />
            <div className="live-dock-options">
              <label className="sr-only" htmlFor="live-new-project">
                选择项目
              </label>
              <select
                id="live-new-project"
                ref={projectSelect}
                value={projectId}
                disabled={busy}
                onChange={(event) => {
                  setProjectId(event.target.value);
                  setGoalId('');
                  setError(null);
                }}
              >
                <option value="">项目：不指定</option>
                {(['registration', 'maintenance'] as const).map((type) => (
                  <optgroup label={type === 'registration' ? '注册项目' : '维护事项'} key={type}>
                    {projects
                      .filter((project) => project.projectType === type)
                      .map((project) => (
                        <option value={project.id} key={project.id}>
                          {project.name}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
              <label className="sr-only" htmlFor="live-new-mode">
                权限模式
              </label>
              <select
                id="live-new-mode"
                value={permissionMode}
                disabled={busy}
                aria-describedby="live-mode-help"
                onChange={(event) => setPermissionMode(event.target.value as PermissionMode)}
              >
                <option value="read_only">只读</option>
                <option value="ask">请求批准</option>
                <option value="full">完全允许</option>
              </select>
              <button
                className="live-primary live-create-submit"
                type="submit"
                aria-label="创建对话"
                aria-busy={busy}
                title={busy ? '正在创建…' : '创建对话'}
                disabled={
                  busy || Boolean(projectId && (goalsQuery.isPending || goalsQuery.isError))
                }
              >
                <ShellIcon name="arrowUp" />
              </button>
            </div>
          </div>
          {!projectId && (
            <p className="live-field-help">可以先保存对话。开始任务前请选择有活动目标的项目。</p>
          )}
          {projectId && (
            <>
              {goalsQuery.isPending && (
                <p className="live-field-help" role="status">
                  正在加载目标…
                </p>
              )}
              {goalsQuery.isError && (
                <p className="live-error" role="alert">
                  目标暂时无法加载。
                  <button
                    className="live-text-button"
                    type="button"
                    onClick={() => void goalsQuery.refetch()}
                  >
                    重试
                  </button>
                </p>
              )}
              {goals.length > 0 && (
                <>
                  <label htmlFor="live-new-goal">工作目标</label>
                  <select
                    id="live-new-goal"
                    value={goalId}
                    disabled={busy}
                    onChange={(event) => setGoalId(event.target.value)}
                  >
                    <option value="">选择工作目标</option>
                    {goals.map((goal) => (
                      <option value={goal.id} key={goal.id}>
                        {goal.title}
                      </option>
                    ))}
                  </select>
                </>
              )}
              {goalsQuery.hasNextPage && (
                <button
                  className="live-text-button"
                  type="button"
                  disabled={goalsQuery.isFetchingNextPage}
                  onClick={() => void goalsQuery.fetchNextPage()}
                >
                  加载更多目标
                </button>
              )}
              {!goalsQuery.isPending &&
                !goalsQuery.isError &&
                goals.length === 0 &&
                !goalsQuery.hasNextPage && (
                  <p className="live-field-help">此项目暂无活动目标，当前只能保存对话。</p>
                )}
            </>
          )}
          <p id="live-mode-help" className="live-field-help">
            {modeDescriptions[permissionMode]}
          </p>
          {error && (
            <p className="live-error" role="alert">
              {error}
            </p>
          )}
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
