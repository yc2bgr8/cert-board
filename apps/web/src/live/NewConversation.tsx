import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { AgentCode, PermissionMode, ProjectRecord } from '@cert-board/shared';
import { api, createRequestKey, errorMessage } from './api.js';
import { ShellIcon } from './ShellIcon.js';

const modeDescriptions: Record<PermissionMode, string> = {
  read_only: '只查看资料与记录，不修改文件或业务记录。',
  ask: '可以整理工作文件；写业务记录和发内部消息前先请你批准。',
  full: '直接处理业务记录和内部消息；外部消息仍逐条批准，最终结果仍需审核。',
};
export function NewConversation({
  open,
  onOpenChange,
  initialProjectId,
  projects,
  userId,
  returnFocus,
  onCreated,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  initialProjectId: string | null;
  projects: ProjectRecord[];
  userId: string;
  returnFocus: RefObject<HTMLElement | null>;
  onCreated(conversationId: string, projectId: string | null): void;
}) {
  const [projectId, setProjectId] = useState('');
  const [agentCode, setAgentCode] = useState<AgentCode>('registration');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask');
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
    setAgentCode('registration');
    setPermissionMode('ask');
    setError(null);
    intent.current = null;
    completed.current = false;
  }, [open, initialProjectId]);
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
      onCreated(result.conversation.id, result.conversation.projectId);
      onOpenChange(false);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog.Root
      modal={false}
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Content
          className="live-dialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            projectSelect.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!completed.current) returnFocus.current?.focus();
          }}
        >
          <div className="live-dialog-heading">
            <Dialog.Title>新对话</Dialog.Title>
            <Dialog.Close className="live-icon-button" aria-label="关闭新对话" disabled={busy}>
              <ShellIcon name="close" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="live-muted">选择项目和本次工作的权限。</Dialog.Description>
          <form className="live-create-form" onSubmit={(event) => void submit(event)}>
            <label htmlFor="live-new-project">选择项目</label>
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
              <option value="">暂不关联项目</option>
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
            {!projectId && (
              <p className="live-field-help">
                可以先保存对话。开始任务时，需要进入一个有目标和资料的项目。
              </p>
            )}
            {selected ? (
              <div className="live-fixed-agent">
                <span>Agent</span>
                <span>{selected.projectType === 'registration' ? '注册Agent' : '维护Agent'}</span>
              </div>
            ) : (
              <>
                <label htmlFor="live-new-agent">选择Agent</label>
                <select
                  id="live-new-agent"
                  value={agentCode}
                  disabled={busy}
                  onChange={(event) => setAgentCode(event.target.value as AgentCode)}
                >
                  <option value="registration">注册Agent</option>
                  <option value="maintenance">维护Agent</option>
                </select>
              </>
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
            <label htmlFor="live-new-title">对话标题</label>
            <input
              id="live-new-title"
              value={title}
              disabled={busy}
              maxLength={255}
              placeholder="可选，简述这次工作"
              onChange={(event) => setTitle(event.target.value)}
            />
            <label htmlFor="live-new-mode">权限模式</label>
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
            <p id="live-mode-help" className="live-field-help">
              {modeDescriptions[permissionMode]}
            </p>
            {error && (
              <p className="live-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="live-primary"
              type="submit"
              aria-label="创建对话"
              disabled={busy || Boolean(projectId && (goalsQuery.isPending || goalsQuery.isError))}
            >
              {busy ? '正在创建…' : '创建对话'}
            </button>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
