import { useCallback, useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentCode, PublicUser, ProjectRecord, GoalRecord } from '@cert-board/shared';
import { api, errorMessage, type ConversationDetail } from './live/api.js';
import { useSession } from './live/useSession.js';
import {
  useMemberNotifications,
  type MemberNotificationSnapshot,
} from './live/useMemberNotifications.js';
import { LiveConversation } from './live/LiveConversation.js';
import { Login } from './live/Login.js';
import { Logo } from './live/Logo.js';
import { Sidebar } from './live/Sidebar.js';
import { ProjectShell } from './live/ProjectShell.js';
import { NewConversation } from './live/NewConversation.js';
import { Search } from './live/Search.js';
import { Settings } from './live/Settings.js';
import { Inspector, type InspectorEntry } from './live/Inspector.js';
import { ProjectFiles } from './live/ProjectFiles.js';
import { ProjectDocuments } from './live/ProjectDocuments.js';
import { ReviewCard } from './live/ReviewCard.js';
import { EvidencePanel } from './live/EvidencePanel.js';
import { DiffPanel } from './live/DiffPanel.js';
import { FilePanel } from './live/FilePanel.js';
import type {
  EvidenceTarget,
  WorkspaceDiffTarget,
  WorkspaceFileTarget,
} from './live/review-navigation.js';
import './live/shell.css';

const time = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const notificationLabels: Record<MemberNotificationSnapshot['items'][number]['kind'], string> = {
  approval: '批准请求',
  question: '等待回答',
  blocked: '需要处理',
  review: '待审核结果',
  proposal: '外发提案',
};
const projectStatuses: Record<ProjectRecord['status'], string> = {
  preparing: '准备中',
  submitted: '已提交',
  under_review: '审评中',
  deficiency: '待补充资料',
  approved: '已获批',
  rejected: '未获批',
  closed: '已关闭',
  cancelled: '已取消',
};
const goalStatuses: Record<GoalRecord['status'], string> = {
  active: '进行中',
  waiting_materials: '等待资料',
  waiting_external: '等待外部',
  waiting_decision: '等待决定',
  pending_review: '待审核',
  human_controlled: '由人处理',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
};
function displayTime(value: string) {
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? '时间待核对' : time.format(instant);
}

function canRestoreFocus(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected || element.matches(':disabled')) return false;
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    if (
      ancestor.hidden ||
      ancestor.hasAttribute('inert') ||
      ancestor.getAttribute('aria-hidden') === 'true'
    )
      return false;
    const style = window.getComputedStyle(ancestor);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse'
    )
      return false;
  }
  return true;
}

export function LiveApp() {
  const session = useSession();
  if (session.status === 'loading')
    return (
      <main className="live-status-page">
        <p role="status">正在检查登录状态…</p>
      </main>
    );
  if (session.status === 'error')
    return (
      <main className="live-status-page">
        <h1>暂时无法连接</h1>
        <p role="alert">{session.error ?? '请确认本地服务已启动后重试。'}</p>
        <button className="live-primary" type="button" onClick={() => void session.refresh()}>
          重新连接
        </button>
      </main>
    );
  if (!session.session || session.status !== 'authenticated')
    return <Login login={session.login} error={session.error} />;
  return <AuthenticatedShell key={session.session.user.id} user={session.session.user} />;
}

function AuthenticatedShell({ user }: { user: PublicUser }) {
  const { logout } = useSession();
  const queryClient = useQueryClient();
  const userId = user.id;
  const [projectId, setProjectId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [view, setView] = useState<'project' | 'conversation' | 'inbox'>('project');
  const [tab, setTab] = useState<'conversation' | 'files' | 'documents'>('conversation');
  const [panels, setPanels] = useState<(InspectorEntry & { trigger: HTMLElement | null })[]>([]);
  const panelKey = useRef(0);
  const panelOrigin = useRef<HTMLElement | null>(null);
  const [scope, setScope] = useState<'mine' | 'department'>('mine');
  const [sidebarAgent, setSidebarAgent] = useState<AgentCode>('registration');
  const [newHeaderAgent, setNewHeaderAgent] = useState<AgentCode>('registration');
  const [dialog, setDialog] = useState<'new' | 'search' | 'settings' | null>(null);
  const [narrow, setNarrow] = useState(
    () => window.matchMedia?.('(max-width: 1023px)').matches ?? false,
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const sidebarVisible = narrow ? mobileOpen : !collapsed;
  const notifications = useMemberNotifications();
  const projectsQuery = useInfiniteQuery({
    queryKey: ['live', 'projects', userId],
    queryFn: ({ pageParam, signal }) =>
      api.projects({ limit: 50, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? (last.nextCursor ?? undefined) : undefined),
    retry: false,
    staleTime: 30_000,
  });
  const projects = projectsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const projectQuery = useQuery({
    queryKey: ['live', 'project', userId, projectId],
    queryFn: ({ signal }) => api.project(projectId!, signal),
    enabled: Boolean(projectId),
    retry: false,
    staleTime: 30_000,
  });
  const selectedProject = projectQuery.data ?? projects.find((project) => project.id === projectId);
  const goalsQuery = useInfiniteQuery({
    queryKey: ['live', 'goals', userId, projectId],
    queryFn: ({ pageParam, signal }) =>
      api.goals(projectId!, { limit: 50, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? (last.nextCursor ?? undefined) : undefined),
    enabled: Boolean(projectId) && view === 'project',
    retry: false,
    staleTime: 15_000,
  });
  const conversationsQuery = useInfiniteQuery({
    queryKey: ['live', 'conversations', userId, projectId],
    queryFn: ({ pageParam, signal }) =>
      api.conversations(
        {
          projectId: projectId!,
          scope: 'all',
          limit: 50,
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? (last.nextCursor ?? undefined) : undefined),
    enabled: Boolean(projectId),
    retry: false,
    staleTime: 10_000,
  });
  const unassignedQuery = useInfiniteQuery({
    queryKey: ['live', 'unassigned', userId],
    queryFn: ({ pageParam, signal }) =>
      api.conversations(
        { scope: 'unassigned', limit: 50, ...(pageParam ? { cursor: pageParam } : {}) },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? (last.nextCursor ?? undefined) : undefined),
    retry: false,
    staleTime: 10_000,
  });
  const searchQuery = useInfiniteQuery({
    queryKey: ['live', 'all-conversations', userId],
    queryFn: ({ pageParam, signal }) =>
      api.conversations(
        { scope: 'all', limit: 50, ...(pageParam ? { cursor: pageParam } : {}) },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? (last.nextCursor ?? undefined) : undefined),
    enabled: dialog === 'search',
    retry: false,
    staleTime: 10_000,
  });
  const conversationQuery = useQuery({
    queryKey: ['live', 'shell-conversation', userId, conversationId],
    queryFn: ({ signal }) => api.conversation(conversationId!, signal),
    enabled: Boolean(conversationId),
    retry: false,
  });
  const current = conversationQuery.data;
  const loaded = conversationsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const allProjectConversations =
    current?.projectId === projectId &&
    !loaded.some((conversation) => conversation.id === current.id)
      ? [...loaded, current]
      : loaded;
  const visibleConversations = allProjectConversations.filter(
    (conversation) => scope === 'department' || conversation.userId === userId,
  );
  const unassigned = (unassignedQuery.data?.pages.flatMap((page) => page.items) ?? []).filter(
    (conversation) => scope === 'department' || conversation.userId === userId,
  );
  const availableProjects =
    selectedProject && !projects.some((project) => project.id === selectedProject.id)
      ? [...projects, selectedProject]
      : projects;

  const openDialog = useCallback((value: 'new' | 'search' | 'settings') => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (value === 'new') setMobileOpen(false);
    setDialog(value);
  }, []);
  const closePanel = useCallback(() => {
    setPanels([]);
    const element = panelOrigin.current;
    setTimeout(() => {
      const target = canRestoreFocus(element)
        ? element
        : [
            document.querySelector<HTMLButtonElement>(
              '.live-project-tabs button[aria-current="page"]',
            ),
            document.querySelector<HTMLButtonElement>('.live-inbox-link'),
            document.querySelector<HTMLButtonElement>('.live-project-header button'),
          ].find(canRestoreFocus);
      target?.focus();
    }, 0);
  }, []);
  function pushPanel(label: string, content: InspectorEntry['content']) {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const entry = { key: ++panelKey.current, label, content, trigger };
    setPanels((previous) => {
      if (previous.length === 0) panelOrigin.current = trigger;
      return [...previous, entry];
    });
  }
  function openEvidence(sources: EvidenceTarget[]) {
    pushPanel('原文依据', <EvidencePanel sources={sources} />);
  }
  function openFile(target: WorkspaceFileTarget) {
    pushPanel('文件', <FilePanel target={target} />);
  }
  function openDiff(target: WorkspaceDiffTarget) {
    pushPanel('改动', <DiffPanel target={target} onOpenFile={openFile} />);
  }
  function openReview(reviewId: string) {
    pushPanel(
      '审核卡',
      <ReviewCard
        reviewId={reviewId}
        onOpenEvidence={openEvidence}
        onOpenDiff={openDiff}
        onOpenFile={openFile}
      />,
    );
  }
  function backPanel() {
    const trigger = panels.at(-1)?.trigger;
    setPanels((previous) => previous.slice(0, -1));
    setTimeout(() => {
      if (trigger?.isConnected) trigger.focus();
    }, 0);
  }
  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 1023px)');
    if (!media) return;
    const update = () => {
      setNarrow(media.matches);
      if (media.matches) setMobileOpen(false);
    };
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openDialog('search');
      }
      if (event.key === 'Escape' && !dialog) {
        if (panels.length) {
          event.preventDefault();
          closePanel();
        } else if (narrow) setMobileOpen(false);
      }
    };
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, [openDialog, dialog, narrow, panels.length, closePanel]);
  useEffect(() => {
    if (current && current.userId !== userId) setScope('department');
  }, [current, userId]);

  const openProject = (id: string) => {
    const project = availableProjects.find((item) => item.id === id);
    if (project) setSidebarAgent(project.projectType);
    setPanels([]);
    setTab('conversation');
    setProjectId(id);
    setConversationId(null);
    setView('project');
    setMobileOpen(false);
  };
  const openConversation = (conversation: ConversationDetail) => {
    setSidebarAgent(conversation.agentCode);
    setPanels([]);
    setTab('conversation');
    setProjectId(conversation.projectId);
    setConversationId(conversation.id);
    setView('conversation');
    setMobileOpen(false);
    if (conversation.userId !== userId) setScope('department');
  };
  const openNotice = (item: MemberNotificationSnapshot['items'][number]) => {
    if (item.kind === 'review') {
      openReview(item.id);
      return;
    }
    const project = availableProjects.find((candidate) => candidate.id === item.projectId);
    if (project) setSidebarAgent(project.projectType);
    setPanels([]);
    setTab('conversation');
    setProjectId(item.projectId);
    setConversationId(item.conversationId);
    setView('conversation');
    setMobileOpen(false);
  };
  const created = (id: string, selectedProjectId: string | null, agentCode: AgentCode) => {
    setSidebarAgent(agentCode);
    setPanels([]);
    setTab('conversation');
    setProjectId(selectedProjectId);
    setConversationId(id);
    setView('conversation');
    setScope('mine');
    setMobileOpen(false);
    for (const key of [
      ['live', 'conversations', userId],
      ['live', 'unassigned', userId],
      ['live', 'all-conversations', userId],
    ])
      void queryClient.invalidateQueries({ queryKey: key });
  };
  const closeSidebar = () => (narrow ? setMobileOpen(false) : setCollapsed(true));
  const openSidebar = () => (narrow ? setMobileOpen(true) : setCollapsed(false));
  const snapshot = notifications.snapshot;
  const isNewConversation = dialog === 'new';
  const projectTitle = selectedProject?.name ?? (projectId ? '正在加载项目…' : '未关联项目');
  const hasConversationTitle = view === 'conversation' && current;
  const title = isNewConversation
    ? '新对话'
    : view === 'inbox'
      ? '待我处理'
      : hasConversationTitle
        ? current.title
        : projectId || conversationId
          ? projectTitle
          : '项目';
  const location = isNewConversation
    ? newHeaderAgent === 'maintenance'
      ? '维护Agent'
      : '注册Agent'
    : hasConversationTitle
      ? projectTitle
      : undefined;
  const collapsedRail = !narrow && collapsed;

  return (
    <div
      className={`live-shell${narrow && mobileOpen ? ' has-mobile-sidebar' : ''}${panels.length && !isNewConversation ? ' has-inspector' : ''}`}
    >
      <Sidebar
        visible={sidebarVisible}
        agent={sidebarAgent}
        newConversation={isNewConversation}
        projects={projects}
        projectsLoading={projectsQuery.isPending}
        projectsError={projectsQuery.isError}
        hasMoreProjects={Boolean(projectsQuery.hasNextPage)}
        loadMoreProjects={() => void projectsQuery.fetchNextPage()}
        retryProjects={() => void projectsQuery.refetch()}
        conversations={visibleConversations}
        conversationsLoading={Boolean(projectId) && conversationsQuery.isPending}
        conversationsError={conversationsQuery.isError}
        hasMoreConversations={Boolean(conversationsQuery.hasNextPage)}
        loadMoreConversations={() => void conversationsQuery.fetchNextPage()}
        unassigned={unassigned}
        hasMoreUnassigned={Boolean(unassignedQuery.hasNextPage)}
        loadMoreUnassigned={() => void unassignedQuery.fetchNextPage()}
        projectId={projectId}
        conversationId={conversationId}
        inbox={view === 'inbox'}
        count={snapshot?.items.length ?? 0}
        truncated={snapshot?.truncated ?? false}
        displayName={user.displayName}
        onProject={openProject}
        onAgent={setSidebarAgent}
        onConversation={openConversation}
        onNew={() => openDialog('new')}
        onSearch={() => openDialog('search')}
        onInbox={() => {
          setPanels([]);
          setTab('conversation');
          setView('inbox');
          setMobileOpen(false);
        }}
        onSettings={() => openDialog('settings')}
        onClose={closeSidebar}
      />
      {collapsedRail && (
        <div className="live-collapsed-rail">
          <button type="button" aria-label="展开侧栏" data-sidebar-toggle onClick={openSidebar}>
            <Logo compact />
          </button>
        </div>
      )}
      {narrow && mobileOpen && (
        <button
          className="live-sidebar-scrim"
          type="button"
          aria-label="关闭项目导航"
          data-sidebar-toggle
          onClick={closeSidebar}
        />
      )}
      <ProjectShell
        title={title}
        {...(location ? { location } : {})}
        sidebarVisible={sidebarVisible || collapsedRail}
        onOpenSidebar={openSidebar}
        tab={tab}
        onTabChange={setTab}
        showTabs={Boolean(projectId) && view !== 'inbox' && !isNewConversation}
      >
        <div
          className="live-view-content"
          hidden={
            isNewConversation ||
            tab !== 'conversation' ||
            (view === 'conversation' && Boolean(current?.projectId))
          }
        >
          {view === 'inbox' ? (
            <section className="live-overview" aria-label="待我处理事项">
              <p className="live-muted">需要你批准、回答或审核的事项。</p>
              {notifications.error && (
                <p className="live-error" role="status">
                  {notifications.error}
                </p>
              )}
              {!snapshot && !notifications.error && <p role="status">正在读取待处理事项…</p>}
              {snapshot?.items.length === 0 && (
                <p className="live-empty">暂时没有需要你处理的事项。</p>
              )}
              {snapshot?.items.map((item) => (
                <button
                  className="live-inbox-row"
                  type="button"
                  key={`${item.kind}:${item.id}`}
                  onClick={() => openNotice(item)}
                >
                  <span>
                    <span className="live-inbox-kind">{notificationLabels[item.kind]}</span>
                    <span>
                      {projects.find((project) => project.id === item.projectId)?.name ??
                        '项目对话'}
                    </span>
                  </span>
                  <span className="live-muted">{displayTime(item.createdAt)}</span>
                  <span className="live-row-action">
                    {item.kind === 'review' ? '查看审核' : '打开对话'}
                  </span>
                </button>
              ))}
              {snapshot?.truncated && (
                <p className="live-field-help">当前列出前50项，处理后会继续更新。</p>
              )}
            </section>
          ) : view === 'conversation' && conversationId ? (
            <>
              {conversationQuery.isPending && (
                <div className="live-overview">
                  <p role="status">正在打开对话…</p>
                </div>
              )}
              {conversationQuery.isError && (
                <div className="live-overview">
                  <p className="live-error" role="alert">
                    {errorMessage(conversationQuery.error)}
                  </p>
                  <button
                    className="live-secondary"
                    type="button"
                    onClick={() => void conversationQuery.refetch()}
                  >
                    重新打开对话
                  </button>
                </div>
              )}
              {current?.projectId === null && (
                <section className="live-overview">
                  <h2>{current.agentCode === 'registration' ? '注册Agent' : '维护Agent'}</h2>
                  <p>对话已保存，尚未关联项目，暂不能启动任务。</p>
                  <p className="live-muted">请从左栏进入项目，再创建有工作目标的对话。</p>
                </section>
              )}
            </>
          ) : projectId ? (
            <section className="live-overview" aria-label="项目对话">
              <div className="live-overview-heading">
                <p>{selectedProject?.projectType === 'maintenance' ? '维护Agent' : '注册Agent'}</p>
                <button className="live-primary" type="button" onClick={() => openDialog('new')}>
                  创建项目对话
                </button>
              </div>
              {selectedProject && (
                <dl className="live-project-summary">
                  <dt>项目状态</dt>
                  <dd>{projectStatuses[selectedProject.status]}</dd>
                </dl>
              )}
              {projectQuery.isError && (
                <p className="live-error" role="alert">
                  {errorMessage(projectQuery.error)}
                </p>
              )}
              {selectedProject?.nextAction && (
                <p className="live-muted">{selectedProject.nextAction}</p>
              )}
              <section className="live-goals" aria-label="工作目标">
                <h2>工作目标</h2>
                {goalsQuery.isPending && (
                  <p className="live-muted" role="status">
                    正在加载目标…
                  </p>
                )}
                {goalsQuery.isError && (
                  <p className="live-error" role="alert">
                    目标暂时无法加载。{' '}
                    <button
                      className="live-text-button"
                      type="button"
                      onClick={() => void goalsQuery.refetch()}
                    >
                      重试工作目标
                    </button>
                  </p>
                )}
                {goalsQuery.data?.pages
                  .flatMap((page) => page.items)
                  .map((goal) => (
                    <div className="live-goal-row" key={goal.id}>
                      <p>
                        {goal.title}
                        {goal.dueAt && <small>目标时间：{displayTime(goal.dueAt)}</small>}
                      </p>
                      <span className="live-muted">{goalStatuses[goal.status]}</span>
                    </div>
                  ))}
                {!goalsQuery.isPending &&
                  !goalsQuery.isError &&
                  goalsQuery.data?.pages.every((page) => page.items.length === 0) && (
                    <p className="live-muted">这个项目还没有工作目标。</p>
                  )}
                {goalsQuery.hasNextPage && (
                  <button
                    className="live-text-button"
                    type="button"
                    disabled={goalsQuery.isFetchingNextPage}
                    onClick={() => void goalsQuery.fetchNextPage()}
                  >
                    加载更多工作目标
                  </button>
                )}
              </section>
              <div className="live-thread-filter" aria-label="对话范围">
                <button
                  type="button"
                  aria-pressed={scope === 'mine'}
                  onClick={() => setScope('mine')}
                >
                  我的对话
                </button>
                <button
                  type="button"
                  aria-pressed={scope === 'department'}
                  onClick={() => setScope('department')}
                >
                  部门对话
                </button>
              </div>
              {conversationsQuery.isPending && <p role="status">正在加载对话…</p>}
              {conversationsQuery.isError && (
                <p className="live-error" role="alert">
                  {errorMessage(conversationsQuery.error)}{' '}
                  <button
                    className="live-text-button"
                    type="button"
                    onClick={() => void conversationsQuery.refetch()}
                  >
                    重试对话列表
                  </button>
                </p>
              )}
              {!conversationsQuery.isPending &&
                !conversationsQuery.isError &&
                visibleConversations.length === 0 && (
                  <p className="live-empty">
                    {conversationsQuery.hasNextPage
                      ? '当前已加载的列表中没有匹配的对话。'
                      : scope === 'mine'
                        ? '你还没有在这个项目中发起对话。'
                        : '这个项目还没有对话。'}
                  </p>
                )}
              {visibleConversations.map((conversation) => (
                <button
                  className="live-conversation-row"
                  type="button"
                  key={conversation.id}
                  aria-label={`打开对话：${conversation.title}`}
                  onClick={() => openConversation(conversation)}
                >
                  <span>
                    {conversation.title}
                    <small>
                      {conversation.ownerName}
                      {!conversation.canWrite ? '，可查看' : ''}
                    </small>
                  </span>
                  <span className="live-muted">{displayTime(conversation.updatedAt)}</span>
                </button>
              ))}
              {conversationsQuery.hasNextPage && (
                <button
                  className="live-secondary"
                  type="button"
                  disabled={conversationsQuery.isFetchingNextPage}
                  onClick={() => void conversationsQuery.fetchNextPage()}
                >
                  继续加载对话
                </button>
              )}
            </section>
          ) : (
            <section className="live-overview live-welcome">
              <h2>从项目开始工作</h2>
              <p className="live-muted">
                在左栏选择注册项目或维护事项，打开已有对话，或创建一段新对话。
              </p>
              {projectsQuery.isError && (
                <button
                  className="live-secondary"
                  type="button"
                  onClick={() => void projectsQuery.refetch()}
                >
                  重新加载项目
                </button>
              )}
            </section>
          )}
        </div>
        {current?.projectId && conversationId && (
          <div
            className="live-thread-host"
            hidden={isNewConversation || view !== 'conversation' || tab !== 'conversation'}
          >
            <LiveConversation
              key={conversationId}
              conversationId={conversationId}
              onReview={openReview}
            />
          </div>
        )}
        {projectId && tab === 'files' && (
          <div className="live-view-content" hidden={isNewConversation}>
            <ProjectFiles
              key={projectId}
              projectId={projectId}
              userId={userId}
              onOpenFile={openFile}
              onOpenDiff={openDiff}
            />
          </div>
        )}
        {projectId && tab === 'documents' && (
          <div className="live-view-content" hidden={isNewConversation}>
            <ProjectDocuments
              key={projectId}
              projectId={projectId}
              userId={userId}
              onOpenEvidence={openEvidence}
            />
          </div>
        )}
        <NewConversation
          open={isNewConversation}
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          initialProjectId={projectId}
          onAgentChange={setNewHeaderAgent}
          projects={availableProjects}
          userId={userId}
          returnFocus={returnFocus}
          onCreated={created}
        />
      </ProjectShell>
      <Inspector
        entries={isNewConversation ? [] : panels}
        onBack={backPanel}
        onClose={closePanel}
      />
      <Search
        open={dialog === 'search'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        projects={availableProjects}
        conversations={searchQuery.data?.pages.flatMap((page) => page.items) ?? []}
        loading={searchQuery.isFetching}
        error={searchQuery.isError ? errorMessage(searchQuery.error) : null}
        retry={() => void searchQuery.refetch()}
        hasMore={Boolean(searchQuery.hasNextPage)}
        loadMore={() => void searchQuery.fetchNextPage()}
        returnFocus={returnFocus}
        onProject={openProject}
        onConversation={openConversation}
      />
      <Settings
        open={dialog === 'settings'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        user={user}
        logout={logout}
        returnFocus={returnFocus}
      />
    </div>
  );
}
