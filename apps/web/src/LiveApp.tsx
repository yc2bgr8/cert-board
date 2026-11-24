import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentCode, PublicUser, ProjectRecord, GoalRecord } from '@cert-board/shared';
import { api, errorMessage, type ConversationDetail } from './live/api.js';
import { useSession } from './live/useSession.js';
import { useConversationStream } from './live/useConversationStream.js';
import {
  useMemberNotifications,
  type MemberNotificationSnapshot,
} from './live/useMemberNotifications.js';
import { LiveConversation } from './live/LiveConversation.js';
import { RunDetails } from './live/RunDetails.js';
import { Login } from './live/Login.js';
import { Logo } from './live/Logo.js';
import { Sidebar } from './live/Sidebar.js';
import { ShellIcon } from './live/ShellIcon.js';
import { ProjectShell } from './live/ProjectShell.js';
import { NewConversation } from './live/NewConversation.js';
import { Search } from './live/Search.js';
import { Settings } from './live/Settings.js';
import { Inspector, type InspectorEntry } from './live/Inspector.js';
import { ProjectFiles } from './live/ProjectFiles.js';
import { ProjectDocuments } from './live/ProjectDocuments.js';
import { ReviewCard } from './live/ReviewCard.js';
import { ProposalCard } from './live/ProposalCard.js';
import { EvidencePanel } from './live/EvidencePanel.js';
import { DiffPanel } from './live/DiffPanel.js';
import { FilePanel } from './live/FilePanel.js';
import { displayTime, Inbox, noticeLabels, ProjectHomeAside } from './live/WorkspacePages.js';
import { VerificationWorkbench } from './live/VerificationWorkbench.js';
import type {
  EvidenceTarget,
  WorkspaceDiffTarget,
  WorkspaceFileTarget,
} from './live/review-navigation.js';
import './live/shell.css';

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
type PanelTarget = Omit<InspectorEntry, 'key' | 'content'> &
  ({ content: InspectorEntry['content'] } | { runId: string });

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

function bookmarkedConversation() {
  const found = new URL(window.location.href).searchParams.get('conversation');
  return found && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(found)
    ? found
    : null;
}

function AuthenticatedShell({ user }: { user: PublicUser }) {
  const { logout } = useSession();
  const queryClient = useQueryClient();
  const userId = user.id;
  const [initialConversation] = useState(bookmarkedConversation);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(initialConversation);
  const [messageDrafts, setMessageDrafts] = useState(() => new Map<string, string>());
  const [view, setView] = useState<'project' | 'conversation' | 'inbox' | 'external'>(
    initialConversation ? 'conversation' : 'project',
  );
  const [externalId, setExternalId] = useState<string | null>(null);
  const [externalDraft, setExternalDraft] = useState(0);
  const [externalNotice, setExternalNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<'conversation' | 'files' | 'documents'>('conversation');
  const [panels, setPanels] = useState<
    (PanelTarget & { key: number; trigger: HTMLElement | null })[]
  >([]);
  const panelKey = useRef(0);
  const panelOrigin = useRef<HTMLElement | null>(null);
  const [scope, setScope] = useState<'mine' | 'department'>('mine');
  const [sidebarAgent, setSidebarAgent] = useState<AgentCode>('registration');
  const [newHeaderAgent, setNewHeaderAgent] = useState<AgentCode>('registration');
  const [dialog, setDialog] = useState<'new' | 'search' | 'settings' | null>(null);
  const [maintenanceSettings, setMaintenanceSettings] = useState(false);
  const [skillRollbackFocus, setSkillRollbackFocus] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(
    () => window.matchMedia?.('(max-width: 1023px)').matches ?? false,
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const sidebarVisible = narrow ? mobileOpen : !collapsed;
  const refreshVerification = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['live', 'linked-verifications'] });
    void queryClient.invalidateQueries({ queryKey: ['live', 'review-verifications'] });
  }, [queryClient]);
  const notifications = useMemberNotifications(true, refreshVerification);
  const externalConversations = useInfiniteQuery({
    queryKey: ['live', 'verification-rooms', userId],
    queryFn: ({ pageParam, signal }) => api.verificationRooms(pageParam, '', signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: view === 'external',
    retry: false,
  });
  const externalThreads = externalConversations.data?.pages.flatMap((page) => page.items) ?? [];
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
  const stream = useConversationStream(conversationId, Boolean(current?.projectId));
  const loaded = conversationsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const allProjectConversations =
    current?.projectId === projectId &&
    !loaded.some((conversation) => conversation.id === current.id)
      ? [...loaded, current]
      : loaded;
  const visibleConversations = allProjectConversations.filter(
    (conversation) => scope === 'department' || conversation.userId === userId,
  );
  const recentConversations = [...visibleConversations].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
  const unassigned = (unassignedQuery.data?.pages.flatMap((page) => page.items) ?? []).filter(
    (conversation) => scope === 'department' || conversation.userId === userId,
  );
  const availableProjects =
    selectedProject && !projects.some((project) => project.id === selectedProject.id)
      ? [...projects, selectedProject]
      : projects;

  const openDialog = useCallback(
    (value: 'new' | 'search' | 'settings', focusSkill: string | null = null) => {
      returnFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (value === 'new' || value === 'settings') setMobileOpen(false);
      if (value === 'settings') {
        setMaintenanceSettings(false);
        setSkillRollbackFocus(focusSkill);
      }
      setDialog(value);
    },
    [],
  );
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
  function pushPanel(target: PanelTarget) {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const entry = { ...target, key: ++panelKey.current, trigger };
    setPanels((previous) => {
      if (previous.length === 0) panelOrigin.current = trigger;
      return [...previous, entry];
    });
  }
  function openEvidence(sources: EvidenceTarget[]) {
    pushPanel({
      label: '原文依据',
      wide: sources.length > 1,
      content: <EvidencePanel sources={sources} />,
    });
  }
  function openFile(target: WorkspaceFileTarget) {
    pushPanel({ label: '文件', content: <FilePanel target={target} /> });
  }
  function openDiff(target: WorkspaceDiffTarget) {
    pushPanel({
      label: '改动',
      wide: true,
      content: <DiffPanel target={target} onOpenFile={openFile} />,
    });
  }
  function openReview(reviewId: string) {
    pushPanel({
      label: '审核卡',
      flush: true,
      content: (
        <ReviewCard
          userId={userId}
          reviewId={reviewId}
          onOpenEvidence={openEvidence}
          onOpenDiff={openDiff}
          onOpenFile={openFile}
          onOpenVerification={openVerification}
        />
      ),
    });
  }
  function openProposal(proposalId: string) {
    pushPanel({
      label: '外发提案',
      flush: true,
      content: (
        <ProposalCard
          proposalId={proposalId}
          onRepropose={(proposal) => {
            const project = availableProjects.find(({ id }) => id === proposal.projectId);
            openConversation({
              id: proposal.conversationId,
              projectId: proposal.projectId,
              userId: proposal.proposedBy,
              agentCode: project?.projectType ?? sidebarAgent,
            });
            updateMessageDraft(proposal.conversationId, (previous) =>
              previous.trim()
                ? previous
                : `请重新核对原外发提案 ${proposal.id} 的收件人和正文，生成新的提案供审核。`,
            );
          }}
        />
      ),
    });
  }
  function updateMessageDraft(id: string, update: SetStateAction<string>) {
    setMessageDrafts((previous) => {
      const currentText = previous.get(id) ?? '';
      const text = typeof update === 'function' ? update(currentText) : update;
      if (text === currentText) return previous;
      const drafts = new Map(previous);
      if (text) drafts.set(id, text);
      else drafts.delete(id);
      return drafts;
    });
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
  const openConversation = useCallback(
    (conversation: Pick<ConversationDetail, 'id' | 'projectId' | 'agentCode' | 'userId'>) => {
      setSidebarAgent(conversation.agentCode);
      setPanels([]);
      setTab('conversation');
      setProjectId(conversation.projectId);
      setConversationId(conversation.id);
      setView('conversation');
      setMobileOpen(false);
      if (conversation.userId !== userId) setScope('department');
    },
    [userId],
  );
  useEffect(() => {
    if (!initialConversation) return;
    const cancel = new AbortController();
    void api.conversation(initialConversation, cancel.signal).then(
      (record) => {
        if (!cancel.signal.aborted && bookmarkedConversation() === initialConversation)
          openConversation(record);
      },
      () => undefined,
    );
    return () => cancel.abort();
  }, [initialConversation, openConversation]);
  useEffect(() => {
    const current = new URL(window.location.href);
    if (view === 'conversation' && conversationId)
      current.searchParams.set('conversation', conversationId);
    else current.searchParams.delete('conversation');
    if (current.href !== window.location.href)
      window.history.replaceState(window.history.state, '', current);
  }, [view, conversationId]);
  const openConversationTarget = (projectId: string | null, conversationId: string | null) => {
    const project = availableProjects.find((candidate) => candidate.id === projectId);
    if (project) setSidebarAgent(project.projectType);
    setPanels([]);
    setTab('conversation');
    setProjectId(projectId);
    setConversationId(conversationId);
    setView('conversation');
    setMobileOpen(false);
  };
  const openNotice = (item: MemberNotificationSnapshot['items'][number]) => {
    if (item.kind === 'skill') {
      openDialog('settings', item.id);
      return;
    }
    if (item.verification) {
      openVerification(item.verification.roomId, item.id);
      return;
    }
    if (item.kind === 'review') {
      openReview(item.id);
      return;
    }
    if (item.kind === 'proposal' || item.kind === 'outbound') {
      openProposal(item.id);
      return;
    }
    openConversationTarget(item.projectId, item.conversationId);
  };
  const created = (
    id: string,
    selectedProjectId: string | null,
    agentCode: AgentCode,
    firstMessage: string,
  ) => {
    if (firstMessage) updateMessageDraft(id, firstMessage);
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
  const openExternal = () => {
    setDialog(null);
    setPanels([]);
    setExternalNotice(null);
    setView('external');
    setTab('conversation');
    setMobileOpen(false);
  };
  const newExternal = () => {
    openExternal();
    setExternalId(null);
    setExternalDraft((currentDraft) => currentDraft + 1);
  };
  const openVerification = (id: string, noticeId?: string) => {
    openExternal();
    if (noticeId || id !== externalId) {
      setExternalId(id);
      setExternalNotice(noticeId ?? null);
      setExternalDraft((currentDraft) => currentDraft + 1);
    }
  };
  const snapshot = notifications.snapshot;
  const isNewConversation = dialog === 'new';
  const isSettings = dialog === 'settings';
  const showMaintenance = isSettings && user.isManagement && maintenanceSettings;
  const hidesWorkspace = isNewConversation || isSettings;
  const projectTitle = selectedProject?.name ?? (projectId ? '正在加载项目…' : '未关联项目');
  const hasConversationTitle = view === 'conversation' && current;
  const title = isNewConversation
    ? '新对话'
    : isSettings
      ? showMaintenance
        ? '维护'
        : '设置'
      : view === 'inbox'
        ? '待我处理'
        : view === 'external'
          ? (externalThreads.find((item) => item.id === externalId)?.title ?? '外部模型')
          : hasConversationTitle
            ? current.title
            : projectId || conversationId
              ? projectTitle
              : '项目';
  const location = isNewConversation
    ? newHeaderAgent === 'maintenance'
      ? '维护Agent'
      : '注册Agent'
    : showMaintenance
      ? '设置'
      : view === 'external' && !isSettings && externalId
        ? '外部模型'
        : hasConversationTitle
          ? projectTitle
          : !isSettings && view === 'inbox'
            ? '注册项目和维护事项'
            : undefined;
  const collapsedRail = !narrow && collapsed;
  const currentRunId = stream.state.currentRunId ?? current?.currentRunId;
  const runDetailsAvailable =
    !hidesWorkspace &&
    view === 'conversation' &&
    tab === 'conversation' &&
    currentRunId &&
    Boolean(stream.state.runs[currentRunId]);
  const proposalNoticeKey = (snapshot?.items ?? [])
    .filter((item) => item.kind === 'proposal' && item.conversationId === conversationId)
    .map((item) => item.id)
    .sort()
    .join(',');
  const entries = hidesWorkspace
    ? []
    : panels.map((panel): InspectorEntry => {
        if ('content' in panel) return panel;
        const run = stream.state.runs[panel.runId];
        return {
          key: panel.key,
          label: panel.label,
          content: run ? <RunDetails run={run} /> : <p role="status">正在同步运行记录…</p>,
        };
      });

  return (
    <div
      className={`live-shell${narrow && mobileOpen ? ' has-mobile-sidebar' : ''}${panels.length && !hidesWorkspace ? ' has-inspector' : ''}`}
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
        external={view === 'external'}
        externalId={externalId}
        externalConversations={externalThreads}
        externalLoading={externalConversations.isPending}
        externalHasMore={externalConversations.hasNextPage}
        externalLoadingMore={externalConversations.isFetchingNextPage}
        onExternalMore={() => void externalConversations.fetchNextPage()}
        externalError={
          externalConversations.isError ? errorMessage(externalConversations.error) : null
        }
        onProject={openProject}
        onAgent={(agent) => {
          setSidebarAgent(agent);
          if (view === 'external') {
            setView('project');
            setConversationId(null);
            if (selectedProject?.projectType !== agent) setProjectId(null);
          }
        }}
        onConversation={openConversation}
        onNew={() => (view === 'external' ? newExternal() : openDialog('new'))}
        onSearch={() => openDialog('search')}
        onInbox={() => {
          setPanels([]);
          setTab('conversation');
          setView('inbox');
          setMobileOpen(false);
        }}
        onSettings={() => openDialog('settings')}
        onExternal={openExternal}
        onExternalNew={newExternal}
        onExternalConversation={openVerification}
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
        showTabs={
          Boolean(projectId) && (view === 'project' || view === 'conversation') && !hidesWorkspace
        }
        headerAction={
          runDetailsAvailable &&
          currentRunId && (
            <button
              className="live-text-button live-run-details-button"
              type="button"
              onClick={() => pushPanel({ label: '运行详情', runId: currentRunId })}
            >
              <ShellIcon name="activity" />
              运行详情
            </button>
          )
        }
        inspector={<Inspector entries={entries} onBack={backPanel} onClose={closePanel} />}
      >
        <div
          className="live-view-content"
          hidden={
            hidesWorkspace ||
            tab !== 'conversation' ||
            (view === 'conversation' && Boolean(current?.projectId))
          }
        >
          {view === 'external' ? (
            <VerificationWorkbench
              key={externalDraft}
              userId={userId}
              roomId={externalId}
              notice={externalNotice ? { id: externalNotice, open: externalDraft } : null}
              onCreated={setExternalId}
              onOpenOrigin={(id) => {
                void api
                  .conversation(id)
                  .then(openConversation)
                  .catch(() => undefined);
              }}
              projects={availableProjects}
              loadMoreProjects={
                projectsQuery.hasNextPage ? () => void projectsQuery.fetchNextPage() : undefined
              }
            />
          ) : view === 'inbox' ? (
            <Inbox
              snapshot={snapshot}
              error={notifications.error}
              projects={projects}
              onOpen={openNotice}
              onOpenDigestTarget={(project, conversation) =>
                conversation ? openConversationTarget(project, conversation) : openProject(project)
              }
            />
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
            <section className="live-workspace-page" aria-label="项目对话">
              <div className="live-page-card live-project-banner">
                <dl>
                  <div>
                    <dt>助手</dt>
                    <dd>
                      {selectedProject
                        ? selectedProject.projectType === 'maintenance'
                          ? '维护Agent'
                          : '注册Agent'
                        : '正在读取…'}
                    </dd>
                  </div>
                  {selectedProject && (
                    <div>
                      <dt>项目状态</dt>
                      <dd>
                        <span className="live-notice-chip">
                          {projectStatuses[selectedProject.status]}
                        </span>
                      </dd>
                    </div>
                  )}
                  {selectedProject?.nextAction && (
                    <div>
                      <dt>下一步</dt>
                      <dd>{selectedProject.nextAction}</dd>
                    </div>
                  )}
                  {selectedProject?.ownerUserId === userId && (
                    <div>
                      <dt>负责人</dt>
                      <dd>{user.displayName}</dd>
                    </div>
                  )}
                </dl>
                <button className="live-primary" type="button" onClick={() => openDialog('new')}>
                  创建项目对话
                </button>
              </div>
              {projectQuery.isError && (
                <p className="live-error" role="alert">
                  {errorMessage(projectQuery.error)}
                </p>
              )}
              <div className="live-page-grid live-project-grid">
                <aside className="live-page-side">
                  <ProjectHomeAside
                    projectId={projectId}
                    userId={userId}
                    snapshot={snapshot}
                    notificationError={notifications.error}
                    conversations={allProjectConversations}
                    onOpenNotice={openNotice}
                    onFiles={() => setTab('files')}
                  />
                  <section className="live-page-card live-page-goals" aria-label="工作目标">
                    <header className="live-page-card-head">
                      <h2>工作目标</h2>
                    </header>
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
                </aside>
                <section
                  className="live-page-card live-project-conversations"
                  aria-label="对话列表"
                >
                  <header className="live-page-card-head">
                    <h2>对话</h2>
                    <span className="live-muted">
                      {visibleConversations.length} 个{conversationsQuery.hasNextPage && '已加载'}
                    </span>
                  </header>
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
                  {recentConversations.map((conversation) => {
                    const notice = snapshot?.items.find(
                      (item) => item.conversationId === conversation.id,
                    );
                    return (
                      <button
                        className="live-conversation-row live-page-list-row"
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
                        <span className={`live-notice-chip${notice ? ` is-${notice.kind}` : ''}`}>
                          {notice
                            ? noticeLabels[notice.kind]
                            : conversation.status === 'archived'
                              ? '已归档'
                              : '活动对话'}
                        </span>
                        <span className="live-muted">{displayTime(conversation.updatedAt)}</span>
                      </button>
                    );
                  })}
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
              </div>
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
            hidden={hidesWorkspace || view !== 'conversation' || tab !== 'conversation'}
          >
            <LiveConversation
              conversationId={conversationId}
              stream={stream}
              text={messageDrafts.get(conversationId) ?? ''}
              setText={(update) => updateMessageDraft(conversationId, update)}
              onReview={openReview}
              proposalNoticeKey={proposalNoticeKey}
              onProposal={openProposal}
              onVerification={openVerification}
            />
          </div>
        )}
        {projectId && tab === 'files' && (
          <div className="live-view-content" hidden={hidesWorkspace}>
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
          <div className="live-view-content" hidden={hidesWorkspace}>
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
        <Settings
          open={isSettings}
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          user={user}
          logout={logout}
          returnFocus={returnFocus}
          maintenance={showMaintenance}
          onMaintenanceChange={setMaintenanceSettings}
          notificationConnection={notifications.connection}
          skillRollbackFocus={skillRollbackFocus}
          openVerification={openVerification}
        />
      </ProjectShell>
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
        userId={userId}
        onVerification={openVerification}
      />
    </div>
  );
}
