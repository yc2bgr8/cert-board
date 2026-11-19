import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import * as Dialog from '@radix-ui/react-dialog';
import { defaultPermissionMode } from '@cert-board/shared';
import { SafeMarkdown } from './SafeMarkdown.js';
import {
  conclusion,
  newThread,
  pending,
  permissionDescriptions,
  projects,
  reviewText,
  running,
  sources,
  type Permission,
  type ProjectKey,
  type Thread,
} from './prototype/data.js';
import './prototype.css';

const paths = {
  plus: 'M12 5v14M5 12h14',
  search: 'm20 20-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  inbox: 'M4 4h16v16H4zM4 13h5l2 3h2l2-3h5',
  folder: 'M3 6h7l2 2h9v12H3z',
  calendar: 'M4 5h16v16H4zM8 3v4M16 3v4M4 10h16',
  chevron: 'm9 5 7 7-7 7',
  close: 'm6 6 12 12M6 18 18 6',
  check: 'm5 12 4 4L19 6',
  file: 'M5 3h9l5 5v13H5zM14 3v6h5M8 13h8M8 17h6',
  attach: 'm8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8',
  panel: 'M3 4h18v16H3zM9 4v16',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  stop: 'M6 6h12v12H6z',
  clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 7v5l3 2',
} as const;
function Icon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
type View = ProjectKey | 'todo' | 'new';
type Panel = {
  kind: 'review' | 'evidence' | 'changes' | 'file' | 'details';
  project: ProjectKey;
  version: number;
  conservative: boolean;
  sourceIndex: number;
} | null;
type Decision = 'return' | 'amend' | 'question' | 'transfer' | null;
const phaseText: Record<Thread['phase'], string> = {
  ready: '可以开始',
  reading: '正在读取项目说明与资料',
  approval: '等待你批准下一步',
  finishing: '正在整理结果并自检',
  review: '等待审核',
  approved: '审核已通过',
  rejected: '已拒绝本次操作',
  returned: '已退回修改',
  stopped: '运行已停止',
  read_complete: '只读检查已完成',
  transferred: '已转交王敏审核',
};
const duration = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

export function PrototypeApp() {
  const [threads, setThreads] = useState<Record<ProjectKey, Thread>>({
    registration: newThread(),
    maintenance: newThread(),
  });
  const [view, setView] = useState<View>('registration');
  const [tab, setTab] = useState('conversation');
  const [newAgent, setNewAgent] = useState<ProjectKey>('registration');
  const [newDraft, setNewDraft] = useState('');
  const [newPermission, setNewPermission] = useState<Permission>(defaultPermissionMode);
  const [panel, setPanel] = useState<Panel>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [planOpen, setPlanOpen] = useState(true);
  const [processOpen, setProcessOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [decision, setDecision] = useState<Decision>(null);
  const [decisionReason, setDecisionReason] = useState('');
  const [notice, setNotice] = useState('');
  const [feedbackReason, setFeedbackReason] = useState<number | null>(null);
  const [feedbackText, setFeedbackText] = useState('');
  const timers = useRef<Partial<Record<ProjectKey, ReturnType<typeof setTimeout>>>>({});
  const sequence = useRef(0);
  const composer = useRef<HTMLTextAreaElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const drawerTitle = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const endOfMessages = useRef<HTMLDivElement>(null);
  const project: ProjectKey =
    view === 'maintenance' ? 'maintenance' : view === 'new' ? newAgent : 'registration';
  const thread = threads[project];
  const active = view === 'registration' || view === 'maintenance';
  const isRunning = active && running(thread);
  const metadata = projects[project];
  const text = view === 'new' ? newDraft : thread.draft;
  const permission = view === 'new' ? newPermission : thread.permission;
  const tasks = (['registration', 'maintenance'] as const).filter((key) => pending(threads[key]));
  const hasRunning = running(threads.registration) || running(threads.maintenance);

  function update(key: ProjectKey, change: (current: Thread) => Thread) {
    setThreads((previous) => ({ ...previous, [key]: change(previous[key]) }));
  }
  function message(role: 'user' | 'agent', value: string) {
    return { id: ++sequence.current, role, text: value };
  }
  function closePanel() {
    setPanel(null);
    setDecision(null);
    returnFocus.current?.focus();
  }
  function openPanel(kind: NonNullable<Panel>['kind'], key = project, sourceIndex = 0) {
    const current = threads[key];
    if (
      kind === 'review' &&
      !['review', 'approved', 'returned', 'transferred'].includes(current.phase)
    ) {
      setNotice('当前还没有提交审核的结果，请先完成本次核查。');
      return;
    }
    if (
      document.activeElement instanceof HTMLElement &&
      !document.activeElement.closest('.right-panel')
    )
      returnFocus.current = document.activeElement;
    setPanel({
      kind,
      project: key,
      version: current.version,
      conservative: current.conservative,
      sourceIndex,
    });
    setDecision(null);
  }
  function openProject(key: ProjectKey) {
    setView(key);
    setTab('conversation');
    setPanel(null);
    setSidebarOpen(false);
    setProcessOpen(false);
    setRejectOpen(false);
    setRejectReason('');
    setFeedbackReason(null);
    setFeedbackText('');
    setNotice('');
    setDecision(null);
  }
  function clearTimer(key: ProjectKey) {
    const timer = timers.current[key];
    if (timer) clearTimeout(timer);
    delete timers.current[key];
  }
  function finish(key: ProjectKey, current: Thread): Thread {
    const notes =
      key === 'maintenance' && !current.conservative
        ? [
            message('agent', '已更新提醒：每周一核对年度注册资料。下一步催办待核对的原件。'),
            message(
              'agent',
              '已向内部同事王敏发送催办：请补充年费付款年度与金额，并核对美国代理人协议签署页。下一步提交审核。',
            ),
          ]
        : [
            message(
              'agent',
              current.conservative
                ? '已保留两处不同写法，不选择正确编号。下一步提交差异记录供你审核。'
                : '已记录处理判断并保存核查记录。下一步完成原文自检并提交审核。',
            ),
          ];
    return {
      ...current,
      phase: 'review',
      onceAllowed: false,
      processCount: key === 'registration' ? 6 : 7,
      elapsed: Math.floor((Date.now() - current.startedAt) / 1000),
      messages: [
        ...current.messages,
        ...notes,
        message('agent', reviewText(key, current.conservative)),
      ],
    };
  }
  function schedule(key: ProjectKey, token: number) {
    clearTimer(key);
    timers.current[key] = setTimeout(() => {
      update(key, (current) => {
        if (current.token !== token || !running(current)) return current;
        if (current.permission === 'read_only')
          return {
            ...current,
            phase: 'read_complete',
            onceAllowed: false,
            processCount: 4,
            messages: [
              ...current.messages,
              message(
                'agent',
                key === 'registration'
                  ? '只读检查已完成：两处写法为 K123456 与 K123465，尚未判断哪处正确。未修改文件或业务记录。'
                  : '只读检查已完成：企业注册年度、付款信息和代理人协议有效期待核对。未更新提醒或发送消息。',
              ),
            ],
          };
        if (current.phase === 'reading') {
          const read = message(
            'agent',
            key === 'registration'
              ? '已读两份资料，发现 K123456 与 K123465 两种写法。下一步判断是否按笔误处理。'
              : '已核对企业注册记录、年费付款凭据和美国代理人协议。下一步更新核对提醒并催办原件。',
          );
          const next = { ...current, processCount: 4, messages: [...current.messages, read] };
          if (current.permission === 'ask' && !current.allowed && !current.conservative)
            return { ...next, phase: 'approval' };
          return finish(key, next);
        }
        if (
          current.permission === 'ask' &&
          !current.allowed &&
          !current.onceAllowed &&
          !current.conservative
        )
          return { ...current, phase: 'approval' };
        return finish(key, current);
      });
    }, 650);
  }
  function start(key: ProjectKey, value: string) {
    const token = ++sequence.current;
    update(key, (previous) => ({
      ...previous,
      phase: 'reading',
      processCount: 0,
      token,
      draft: '',
      conservative: false,
      onceAllowed: false,
      version: previous.phase === 'ready' ? 1 : previous.version + 1,
      startedAt: Date.now(),
      elapsed: 0,
      messages: [
        ...previous.messages,
        message('user', value),
        message(
          'agent',
          key === 'registration'
            ? '我会先读取项目说明和 R09 技能，再对照两处 K 号原文；记录判断、自检后提交审核。'
            : '我会先读取项目说明和 M02 技能，再核对三项资料；更新提醒和催办后提交审核。',
        ),
      ],
    }));
    setProcessOpen(false);
    setPlanOpen(true);
    setRejectOpen(false);
    setNotice('');
    schedule(key, token);
  }
  function send() {
    if (!text.trim()) return;
    if (isRunning) {
      update(project, (current) => ({
        ...current,
        draft: '',
        messages: [
          ...current.messages,
          message('user', text),
          message('agent', '已收到补充，将在下一步处理；当前读取继续。'),
        ],
      }));
      return;
    }
    if (view === 'new') {
      if (running(threads[project]) || pending(threads[project])) {
        setNotice('该项目还有运行或待处理结果，请先处理当前对话后再新建对话。');
        return;
      }
      clearTimer(project);
      const token = ++sequence.current;
      setThreads((previous) => ({
        ...previous,
        [project]: {
          ...newThread(newPermission),
          phase: 'reading',
          token,
          startedAt: Date.now(),
          messages: [
            message('user', text),
            message(
              'agent',
              `我会先读取项目说明和相关技能，列出步骤后开始${project === 'registration' ? '核对K号' : '年度核查'}。`,
            ),
          ],
        },
      }));
      setNewDraft('');
      setView(project);
      setPlanOpen(true);
      setTab('conversation');
      schedule(project, token);
    } else start(project, text);
  }
  function stop() {
    clearTimer(project);
    update(project, (current) => ({
      ...current,
      phase: 'stopped',
      token: current.token + 1,
      elapsed: Math.floor((Date.now() - current.startedAt) / 1000),
      messages: [
        ...current.messages,
        message(
          'agent',
          '运行已停止。已读取的内容保留，尚未完成的操作未执行；你可以补充要求后重新发送。',
        ),
      ],
    }));
  }
  function allow(all: boolean) {
    const token = ++sequence.current;
    update(project, (current) => ({
      ...current,
      phase: 'finishing',
      token,
      allowed: all || current.allowed,
      onceAllowed: true,
      messages: [
        ...current.messages,
        message(
          'agent',
          all
            ? '已允许本对话中同一操作继续执行。下一步整理判断与结果。'
            : '已收到允许，下一步执行本次操作并整理结果。',
        ),
      ],
    }));
    setRejectOpen(false);
    schedule(project, token);
  }
  function reject() {
    update(project, (current) => ({
      ...current,
      phase: 'rejected',
      allowed: false,
      onceAllowed: false,
      conservative: true,
      messages: [
        ...current.messages,
        message(
          'agent',
          `已拒绝本次${project === 'registration' ? '判断' : '操作'}${rejectReason.trim() ? `，原因：${rejectReason}` : '。'}\n\n${project === 'registration' ? '我会保留两处不同写法，不把任一编号当作已确认事实。可以仅列差异继续。' : '我会保留待核对事项，不更新提醒或发送催办。请补充希望如何处理。'}`,
        ),
      ],
    }));
    setRejectOpen(false);
    setRejectReason('');
  }
  function continueDifferences() {
    const token = ++sequence.current;
    update(project, (current) => ({ ...current, phase: 'finishing', conservative: true, token }));
    schedule(project, token);
  }
  function changePermission(value: Permission) {
    if (view === 'new') {
      setNewPermission(value);
      return;
    }
    update(project, (current) => ({
      ...current,
      permission: value,
      onceAllowed: value === 'read_only' ? false : current.onceAllowed,
    }));
    setNotice(
      `权限已切换为${value === 'ask' ? '请求批准' : value === 'full' ? '完全允许' : '只读'}，从下一次工具调用起生效。`,
    );
    if (thread.phase === 'approval' && value !== 'ask') {
      const token = ++sequence.current;
      update(project, (current) => ({ ...current, phase: 'finishing', token }));
      schedule(project, token);
    }
  }
  function approve() {
    if (!panel || panel.kind !== 'review') return;
    update(panel.project, (current) =>
      current.version !== panel.version || current.phase !== 'review'
        ? current
        : {
            ...current,
            phase: 'approved',
            messages: [
              ...current.messages,
              message(
                'agent',
                `审核已通过。${projects[panel.project].filename}已按工作区第${current.version}版定稿。`,
              ),
            ],
          },
    );
    setDecision(null);
  }
  function decide() {
    if (!panel || !decision || !decisionReason.trim()) return;
    const action = decision;
    update(panel.project, (current) => {
      if (current.version !== panel.version || current.phase !== 'review') return current;
      return {
        ...current,
        phase:
          action === 'amend'
            ? 'approved'
            : action === 'transfer'
              ? 'transferred'
              : action === 'return'
                ? 'returned'
                : 'review',
        messages: [
          ...current.messages,
          message('user', decisionReason),
          message(
            'agent',
            action === 'return'
              ? '已退回修改。已保留你的原因，请在对话中补充要求，我会修改后重新提交。'
              : action === 'amend'
                ? '修改意见已记录，审核已通过。'
                : action === 'transfer'
                  ? '已转交王敏审核，当前结果仍等待人工决定。'
                  : '已收到追问，当前审核保持待处理；请在对话中补充核对要求。',
          ),
        ],
      };
    });
    setDecision(null);
    setDecisionReason('');
  }

  useEffect(
    () => () => {
      for (const timer of Object.values(timers.current)) clearTimeout(timer);
    },
    [],
  );
  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(
      () =>
        setThreads((previous) => ({
          registration: running(previous.registration)
            ? {
                ...previous.registration,
                elapsed: Math.floor((Date.now() - previous.registration.startedAt) / 1000),
              }
            : previous.registration,
          maintenance: running(previous.maintenance)
            ? {
                ...previous.maintenance,
                elapsed: Math.floor((Date.now() - previous.maintenance.startedAt) / 1000),
              }
            : previous.maintenance,
        })),
      1000,
    );
    return () => clearInterval(timer);
  }, [hasRunning]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key === 'Escape' && !searchOpen && !settingsOpen && feedbackReason === null) {
        closePanel();
        setSidebarOpen(false);
      }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [searchOpen, settingsOpen, feedbackReason]);
  useEffect(() => {
    if (panel) drawerTitle.current?.focus();
  }, [panel?.kind]);
  useEffect(() => {
    endOfMessages.current?.scrollIntoView?.({ block: 'nearest' });
  }, [thread.messages.length, view]);

  const completed =
    thread.phase === 'reading'
      ? 0
      : thread.phase === 'approval' ||
          thread.phase === 'rejected' ||
          thread.phase === 'read_complete'
        ? 2
        : thread.phase === 'finishing'
          ? 3
          : thread.phase === 'ready' || thread.phase === 'stopped'
            ? thread.processCount >= 4
              ? 2
              : 0
            : 4;
  const steps =
    project === 'registration'
      ? [
          '读取项目说明与 R09 技能',
          '读取对比器械对照表，第2页',
          '读取510(k)摘要，第4页',
          '对照 K123456 与 K123465',
          thread.conservative ? '保留差异，不选择正确编号' : '记录经确认的笔误判断',
          '核对原文并提交审核',
        ]
      : [
          '读取项目说明与 M02 技能',
          '读取企业注册记录，第1页',
          '读取年费付款凭据，第1页',
          '读取美国代理人协议，第1页',
          '更新年度资料核对提醒',
          '向内部同事王敏发送催办',
          '核对原文并提交审核',
        ];
  const shownSteps =
    thread.phase === 'reading' ? steps.slice(0, 1) : steps.slice(0, thread.processCount);
  const setDraft = (value: string) =>
    view === 'new'
      ? setNewDraft(value)
      : update(project, (current) => ({ ...current, draft: value }));
  const drawerProject = panel?.project ?? project;
  const drawerThread = threads[drawerProject];
  const drawerMetadata = projects[drawerProject];
  const stale = panel !== null && panel.version !== drawerThread.version;
  const source = panel ? sources[panel.project][panel.sourceIndex] : undefined;

  return (
    <div
      className={`prototype-shell${sidebarOpen ? ' sidebar-open' : ''}${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}
    >
      <aside className="left-sidebar" aria-label="项目导航">
        <div className="sidebar-top">
          <button
            className="nav-button"
            onClick={() => {
              setView('new');
              setNewAgent('registration');
              setNewPermission(defaultPermissionMode);
              setNewDraft('');
              setPanel(null);
              setSidebarOpen(false);
            }}
          >
            <Icon name="plus" />
            新对话
          </button>
          <button
            className="icon-button collapse-sidebar"
            aria-label="收起侧栏"
            onClick={() => {
              setSidebarCollapsed(true);
              setSidebarOpen(false);
            }}
          >
            <Icon name="panel" />
          </button>
        </div>
        <button className="nav-button search-nav" onClick={() => setSearchOpen(true)}>
          <Icon name="search" />
          搜索<span className="shortcut">Ctrl K</span>
        </button>
        <button
          className={`nav-button inbox-nav${view === 'todo' ? ' selected' : ''}`}
          onClick={() => {
            setView('todo');
            setPanel(null);
            setSidebarOpen(false);
          }}
        >
          <Icon name="inbox" />
          待我处理{tasks.length > 0 && <span className="pending-count">{tasks.length}</span>}
        </button>
        <div className="navigation-groups">
          <p className="nav-section-label">注册项目</p>
          <button
            className={`nav-button${view === 'registration' ? ' selected' : ''}`}
            onClick={() => openProject('registration')}
          >
            <Icon name="folder" />
            L08 510(k)
          </button>
          <button className="conversation-nav" onClick={() => openProject('registration')}>
            K号写法检查
          </button>
          <p className="nav-section-label maintenance-label">维护事项</p>
          <button
            className={`nav-button${view === 'maintenance' ? ' selected' : ''}`}
            onClick={() => openProject('maintenance')}
          >
            <Icon name="calendar" />
            L08 年度注册
          </button>
          <button className="conversation-nav" onClick={() => openProject('maintenance')}>
            年度注册核查
          </button>
        </div>
        <div className="sidebar-bottom">
          <span>张三</span>
          <button onClick={() => setSettingsOpen(true)}>
            <Icon name="settings" />
            设置
          </button>
        </div>
      </aside>
      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          aria-label="关闭项目导航"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <main className="main-column">
        <header className="project-header">
          <button
            className="icon-button expand-sidebar"
            aria-label="展开侧栏"
            onClick={() => {
              setSidebarCollapsed(false);
              setSidebarOpen(true);
            }}
          >
            <Icon name="panel" />
          </button>
          <h1>{view === 'todo' ? '待我处理' : view === 'new' ? '新对话' : metadata.name}</h1>
          {active && (
            <>
              <span className="conversation-title">{metadata.conversation}</span>
              <Tabs.Root value={tab} onValueChange={setTab} className="header-tabs">
                <Tabs.List aria-label="项目内容">
                  <Tabs.Trigger
                    value="conversation"
                    id="project-tab-conversation"
                    aria-controls="project-content-panel"
                  >
                    对话
                  </Tabs.Trigger>
                  <Tabs.Trigger
                    value="files"
                    id="project-tab-files"
                    aria-controls="project-content-panel"
                  >
                    文件
                  </Tabs.Trigger>
                  <Tabs.Trigger
                    value="sources"
                    id="project-tab-sources"
                    aria-controls="project-content-panel"
                  >
                    资料
                  </Tabs.Trigger>
                </Tabs.List>
              </Tabs.Root>
            </>
          )}
        </header>
        <div
          className="project-body"
          id="project-content-panel"
          role={active ? 'tabpanel' : undefined}
          aria-labelledby={active ? `project-tab-${tab}` : undefined}
          tabIndex={active ? 0 : undefined}
        >
          {view === 'todo' ? (
            <section className="todo-content" aria-label="待我处理事项">
              <p className="secondary">批准下一步操作，或审核已提交的结果。</p>
              {tasks.length === 0 ? (
                <div className="empty-todo">
                  <Icon name="check" />
                  <p>暂时没有需要你处理的事项</p>
                  <button className="text-button" onClick={() => openProject('registration')}>
                    进入L08项目
                  </button>
                </div>
              ) : (
                tasks.map((key) => (
                  <button
                    className="todo-row"
                    key={key}
                    onClick={() => {
                      openProject(key);
                      if (threads[key].phase === 'review') openPanel('review', key);
                    }}
                  >
                    <Icon name={threads[key].phase === 'approval' ? 'inbox' : 'file'} />
                    <span>
                      <span className="todo-kind">
                        {threads[key].phase === 'approval' ? '批准请求' : '待审核'}
                      </span>
                      <span>{projects[key].name}</span>
                      <small>
                        {threads[key].phase === 'approval'
                          ? key === 'registration'
                            ? '确认对比器械K号的处理判断'
                            : '更新提醒并发送内部催办'
                          : projects[key].filename}
                      </small>
                    </span>
                    <span className="todo-action">
                      {threads[key].phase === 'approval' ? '处理批准请求' : '查看审核'}
                    </span>
                  </button>
                ))
              )}
            </section>
          ) : active && tab !== 'conversation' ? (
            <section
              className="library-view"
              aria-label={tab === 'files' ? '项目文件' : '项目资料'}
            >
              <div className="library-heading">
                <h2>{tab === 'files' ? '工作区文件' : '资料库'}</h2>
                <button
                  className="text-button"
                  onClick={() => setNotice('当前不能添加附件，请先使用资料库中的资料。')}
                >
                  添加{tab === 'files' ? '文件' : '资料'}
                </button>
              </div>
              {tab === 'files' ? (
                <>
                  <button className="file-row" onClick={() => openPanel('file')}>
                    <Icon name="file" />
                    <span>
                      AGENTS.md<small>项目说明</small>
                    </span>
                    <span className="secondary">第1版</span>
                  </button>
                  {['review', 'approved', 'returned', 'transferred'].includes(thread.phase) && (
                    <button className="file-row" onClick={() => openPanel('changes')}>
                      <Icon name="file" />
                      <span>
                        {metadata.filename}
                        <small>核查记录</small>
                      </span>
                      <span className="secondary">第{thread.version}版</span>
                    </button>
                  )}
                </>
              ) : (
                sources[project].map((item, index) => (
                  <button
                    className="file-row"
                    key={item.id}
                    onClick={() => openPanel('evidence', project, index)}
                  >
                    <Icon name="file" />
                    <span>
                      {item.name}
                      <small>
                        {item.id}，第1版，第{item.page}页
                      </small>
                    </span>
                    <span className="secondary">查看原文</span>
                  </button>
                ))
              )}
              {notice && (
                <p className="inline-notice" role="status">
                  {notice}
                </p>
              )}
            </section>
          ) : (
            <>
              <div className="conversation-scroll">
                <section className="conversation-content" aria-label="对话记录">
                  {view === 'new' || thread.messages.length === 0 ? (
                    <div className="welcome">
                      <h2>
                        {project === 'registration'
                          ? '从需要核对的问题开始'
                          : '一起处理年度注册事项'}
                      </h2>
                      <p className="secondary">
                        {project === 'registration'
                          ? '读取资料、对照依据，把判断和改动交给你审核。'
                          : '核对资料、跟进提醒，把结果和未确认事项交给你审核。'}
                      </p>
                      <button
                        className="suggested-task"
                        onClick={() => {
                          setDraft(metadata.prompt);
                          composer.current?.focus();
                        }}
                      >
                        <Icon name="file" />
                        {metadata.task}
                      </button>
                    </div>
                  ) : (
                    <>
                      {thread.messages.map((entry) => (
                        <article className={`chat-message ${entry.role}`} key={entry.id}>
                          {entry.role === 'agent' && <p className="agent-name">{metadata.agent}</p>}
                          <SafeMarkdown>{entry.text}</SafeMarkdown>
                          {entry.role === 'agent' && (
                            <div className="message-feedback">
                              <button
                                onClick={() =>
                                  update(project, (current) => ({
                                    ...current,
                                    feedback: { ...current.feedback, [entry.id]: '已记录有用反馈' },
                                  }))
                                }
                              >
                                有用
                              </button>
                              <button
                                onClick={() => {
                                  setFeedbackReason(entry.id);
                                  setFeedbackText('');
                                }}
                              >
                                没用
                              </button>
                              {thread.feedback[entry.id] && (
                                <span role="status">{thread.feedback[entry.id]}</span>
                              )}
                            </div>
                          )}
                        </article>
                      ))}
                      <section className="process-section" aria-label="工具过程">
                        <button
                          className="process-toggle"
                          aria-expanded={processOpen}
                          onClick={() => setProcessOpen(!processOpen)}
                        >
                          <span className={processOpen ? 'chevron-open' : ''}>
                            <Icon name="chevron" />
                          </span>
                          {isRunning ? '正在执行' : '已执行'} {shownSteps.length} 步
                        </button>
                        {processOpen && (
                          <ol className="tool-steps">
                            {shownSteps.map((step, index) => (
                              <li key={step}>
                                <Icon
                                  name={
                                    isRunning && index === shownSteps.length - 1 ? 'clock' : 'check'
                                  }
                                />
                                <span>{step}</span>
                              </li>
                            ))}
                            <li>
                              <button className="text-button" onClick={() => openPanel('details')}>
                                运行详情
                              </button>
                            </li>
                          </ol>
                        )}
                      </section>
                      {['approval', 'review', 'approved', 'read_complete'].includes(
                        thread.phase,
                      ) && (
                        <div className="inline-evidence">
                          <span className="secondary">原文依据</span>
                          {sources[project].map((item, index) => (
                            <button
                              key={item.id}
                              className="citation"
                              title={`${item.name}，第${item.page}页`}
                              aria-label={`查看依据${index + 1}：${item.name}`}
                              onClick={() => openPanel('evidence', project, index)}
                            >
                              <sup>{index + 1}</sup>
                            </button>
                          ))}
                        </div>
                      )}
                      {['review', 'approved', 'returned', 'transferred'].includes(thread.phase) && (
                        <div className="result-row">
                          <span>
                            {phaseText[thread.phase]}：{metadata.filename}
                          </span>
                          <button className="primary-text" onClick={() => openPanel('review')}>
                            审核
                          </button>
                          <button className="text-button" onClick={() => openPanel('changes')}>
                            查看改动
                          </button>
                        </div>
                      )}
                      {thread.phase === 'rejected' && project === 'registration' && (
                        <button className="text-button" onClick={continueDifferences}>
                          仅列差异并继续
                        </button>
                      )}
                    </>
                  )}
                  <div ref={endOfMessages} />
                </section>
              </div>
              <div className="composer-area">
                {active && thread.phase !== 'ready' && (
                  <section className="plan-block" aria-label="计划与待办">
                    <button
                      className="plan-toggle"
                      aria-expanded={planOpen}
                      onClick={() => setPlanOpen(!planOpen)}
                    >
                      <span className={planOpen ? 'chevron-open' : ''}>
                        <Icon name="chevron" />
                      </span>
                      计划与待办
                      <span className="secondary">第 {Math.min(completed + 1, 4)} 步，共 4 步</span>
                    </button>
                    {planOpen && (
                      <ol>
                        {metadata.plan.map((step, index) => (
                          <li key={step} className={index < completed ? 'plan-done' : ''}>
                            {index < completed ? (
                              <Icon name="check" />
                            ) : (
                              <span className="plan-check" />
                            )}
                            <span>{step}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </section>
                )}
                {active && thread.phase === 'approval' && (
                  <section className="approval-card" aria-label="批准请求">
                    <h2>
                      {project === 'registration' ? '确认这项判断后继续' : '允许更新提醒并催办'}
                    </h2>
                    {project === 'registration' ? (
                      <>
                        <p>
                          建议将 <code>K123465</code> 作为笔误处理，候选统一为 <code>K123456</code>
                          。
                        </p>
                        <p className="secondary">
                          改前：两处编号不同，尚未选择正确编号。
                          <br />
                          改后：在核查记录中记录候选统一写法；原始资料不变。
                        </p>
                      </>
                    ) : (
                      <>
                        <p>将核对提醒设为每周一，并向内部同事王敏催办付款信息与协议签署页。</p>
                        <p className="secondary">
                          改前：提醒未设置，资料待核对。
                          <br />
                          改后：记录提醒并发送一条内部催办。
                        </p>
                      </>
                    )}
                    <div className="approval-buttons">
                      <button className="primary-button" onClick={() => allow(false)}>
                        允许
                      </button>
                      <button className="secondary-button" onClick={() => allow(true)}>
                        本对话中都允许
                      </button>
                      <button className="text-button" onClick={() => setRejectOpen(true)}>
                        拒绝
                      </button>
                    </div>
                    {rejectOpen && (
                      <div className="reason-form">
                        <label htmlFor="approval-reason">拒绝原因</label>
                        <textarea
                          id="approval-reason"
                          value={rejectReason}
                          onChange={(event) => setRejectReason(event.target.value)}
                          placeholder="可选，说明希望如何调整"
                        />
                        <button className="secondary-button" onClick={reject}>
                          确认拒绝
                        </button>
                      </div>
                    )}
                  </section>
                )}
                {active && thread.phase !== 'ready' && (
                  <div className="run-status" role="status">
                    <span>
                      {phaseText[thread.phase]}
                      {`，第 ${Math.min(completed + 1, 4)} 步，共 4 步`}
                    </span>
                    <span className="secondary">已用 {duration(thread.elapsed)}</span>
                    {isRunning && (
                      <button className="text-button" onClick={stop}>
                        停止运行
                      </button>
                    )}
                  </div>
                )}
                {notice && (
                  <p className="inline-notice" role="status">
                    {notice}
                  </p>
                )}
                <div className="composer">
                  <textarea
                    ref={composer}
                    aria-label="给Agent的消息"
                    placeholder={`让${metadata.agent}做什么？`}
                    value={text}
                    rows={2}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === 'Enter' &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing &&
                        event.keyCode !== 229
                      ) {
                        event.preventDefault();
                        send();
                      }
                    }}
                  />
                  <div className="composer-toolbar">
                    <button
                      className="composer-control"
                      onClick={() => setNotice('当前不能添加附件，请先使用资料库中的资料。')}
                    >
                      <Icon name="attach" />
                      附件
                    </button>
                    {view === 'new' ? (
                      <select
                        aria-label="选择Agent"
                        value={newAgent}
                        onChange={(event) => setNewAgent(event.target.value as ProjectKey)}
                      >
                        <option value="registration">注册Agent</option>
                        <option value="maintenance">维护Agent</option>
                      </select>
                    ) : (
                      <span className="fixed-agent">{metadata.agent}</span>
                    )}
                    <select
                      aria-label="权限模式"
                      value={permission}
                      title={permissionDescriptions[permission]}
                      onChange={(event) => changePermission(event.target.value as Permission)}
                    >
                      <option value="read_only">只读</option>
                      <option value="ask">请求批准</option>
                      <option value="full">完全允许</option>
                    </select>
                    {isRunning ? (
                      <button className="primary-button send-button" onClick={stop}>
                        <Icon name="stop" />
                        停止
                      </button>
                    ) : (
                      <button
                        className="primary-button send-button"
                        disabled={!text.trim()}
                        onClick={send}
                      >
                        发送
                      </button>
                    )}
                  </div>
                </div>
                <p className="mode-description">
                  {permissionDescriptions[permission]}
                  {isRunning && ' 输入后按回车可以补充要求。'}
                </p>
              </div>
            </>
          )}
        </div>
      </main>
      {panel && (
        <aside
          className="right-panel"
          aria-label={
            panel.kind === 'review'
              ? '审核详情'
              : panel.kind === 'evidence'
                ? '原文依据'
                : panel.kind === 'changes'
                  ? '文件改动'
                  : panel.kind === 'details'
                    ? '运行详情'
                    : '文件内容'
          }
        >
          <header className="panel-header">
            <h2 ref={drawerTitle} tabIndex={-1}>
              {panel.kind === 'review'
                ? '审核'
                : panel.kind === 'evidence'
                  ? '原文依据'
                  : panel.kind === 'changes'
                    ? '改动'
                    : panel.kind === 'details'
                      ? '运行详情'
                      : '项目说明'}
            </h2>
            <button className="icon-button" aria-label="关闭右栏" onClick={closePanel}>
              <Icon name="close" />
            </button>
          </header>
          <div className="panel-scroll">
            {panel.kind === 'review' ? (
              <>
                <p className="review-version">
                  工作区第{panel.version}版，{drawerMetadata.filename}
                </p>
                {stale && (
                  <div className="version-warning" role="alert">
                    工作区版本已变化，请刷新审核内容。
                    <button
                      className="text-button"
                      onClick={() => openPanel('review', panel.project)}
                    >
                      刷新审核
                    </button>
                  </div>
                )}
                <ReviewSection title="结论">
                  <p className="review-conclusion">
                    {conclusion(panel.project, panel.conservative)}
                  </p>
                </ReviewSection>
                <ReviewSection title="需要你做什么">
                  <p>
                    {panel.project === 'registration'
                      ? '核对候选处理与两处原文；同意则通过，不同意请退回修改。'
                      : '核对提醒和催办内容是否恰当，并确认待补充的原件范围。'}
                  </p>
                </ReviewSection>
                <ReviewSection title="过程中作出的判断">
                  <dl className="decision-list">
                    <dt>事项</dt>
                    <dd>
                      {panel.project === 'registration' ? '对比器械K号的写法' : '年度资料跟进方式'}
                    </dd>
                    <dt>Agent的选择</dt>
                    <dd>
                      {panel.project === 'registration'
                        ? panel.conservative
                          ? '保留差异，暂不选择正确编号。'
                          : '将 K123465 作为笔误记录，候选统一为 K123456。'
                        : '先更新资料核对提醒，再向内部同事王敏催办原件。'}
                    </dd>
                    <dt>考虑过的备选</dt>
                    <dd>
                      {panel.project === 'registration'
                        ? '保留两处差异，等待原件核对后再作判断。'
                        : '暂不更新提醒，等待全部原件到齐后集中核对。'}
                    </dd>
                    <dt>理由</dt>
                    <dd>
                      {panel.project === 'registration'
                        ? '两处字段指向同一对比器械，数字顺序不同；本次处理不改写原始资料。'
                        : '三项资料均有待核对信息，先跟进原件有助于完成年度核查。'}
                    </dd>
                    <dt>依据</dt>
                    <dd>
                      {sources[panel.project].map((item, index) => (
                        <button
                          className="source-link"
                          key={item.id}
                          onClick={() => openPanel('evidence', panel.project, index)}
                        >
                          {item.name}，第{item.page}页
                        </button>
                      ))}
                    </dd>
                    <dt>风险高低</dt>
                    <dd>
                      高。
                      {panel.project === 'registration'
                        ? '正确编号仍需原件确认。'
                        : '年度适用性与期限仍需原件确认。'}
                    </dd>
                  </dl>
                </ReviewSection>
                <ReviewSection title="改动">
                  <p>
                    {panel.project === 'registration'
                      ? '新增核查记录，记录两处引文和处理判断。'
                      : '新增年度核查记录，记录提醒与内部催办。'}
                  </p>
                  <button
                    className="text-button"
                    onClick={() => openPanel('changes', panel.project)}
                  >
                    查看文件改动
                  </button>
                </ReviewSection>
                <ReviewSection title="依据">
                  {sources[panel.project].map((item, index) => (
                    <div className="review-evidence" key={item.id}>
                      <button
                        className="source-link"
                        onClick={() => openPanel('evidence', panel.project, index)}
                      >
                        {item.name}，第{item.page}页
                      </button>
                      <blockquote>{item.quote}</blockquote>
                    </div>
                  ))}
                </ReviewSection>
                <ReviewSection title="自检">
                  <p className="check-result">
                    <Icon name="check" />
                    原文摘录与资料页一致
                  </p>
                  <p className="check-result">
                    <Icon name="check" />
                    结构化结果完整
                  </p>
                  <p className="secondary">未运行法规适用性、期限及数值单位检查。</p>
                </ReviewSection>
                <ReviewSection title="不确定事项">
                  <p>
                    {panel.project === 'registration'
                      ? '本次对照不能单独证明哪个K号正确；发布前仍需核对原始申报记录。'
                      : '适用年度、付款金额和协议有效期未完成原件确认，不据此认定逾期或注册有效。'}
                  </p>
                </ReviewSection>
              </>
            ) : panel.kind === 'evidence' ? (
              <>
                <div className="evidence-tabs">
                  {sources[panel.project].map((item, index) => (
                    <button
                      className={index === panel.sourceIndex ? 'current-source' : ''}
                      key={item.id}
                      onClick={() => setPanel({ ...panel, sourceIndex: index })}
                    >
                      {item.name}
                    </button>
                  ))}
                </div>
                {source && (
                  <>
                    <p className="secondary">
                      {source.id}，资料第1版，第{source.page}页
                    </p>
                    <div className="evidence-comparison">
                      <section className="parsed-source" aria-label="解析原文">
                        <h3>解析原文</h3>
                        {source.text.split('\n').map((line, index) => (
                          <p key={index}>{line === source.quote ? <mark>{line}</mark> : line}</p>
                        ))}
                      </section>
                      <section className="source-original" aria-label="原页">
                        <h3>原页</h3>
                        <div className="source-page">
                          <p className="source-page-title">{source.name}</p>
                          {source.text.split('\n').map((line, index) => (
                            <p key={index}>{line === source.quote ? <mark>{line}</mark> : line}</p>
                          ))}
                          <p className="source-page-number">{source.page}</p>
                        </div>
                      </section>
                    </div>
                  </>
                )}
                {['review', 'approved', 'returned', 'transferred'].includes(drawerThread.phase) && (
                  <button
                    className="text-button"
                    onClick={() => openPanel('review', panel.project)}
                  >
                    返回审核
                  </button>
                )}
              </>
            ) : panel.kind === 'changes' ? (
              <>
                <p className="review-version">工作区第{panel.version}版</p>
                <h3 className="filename">{drawerMetadata.filename}</h3>
                <p className="secondary">新增核查记录；原始资料未修改。</p>
                <div className="diff-lines">
                  {(panel.project === 'registration'
                    ? [
                        '+ 对比器械对照表：K123456',
                        '+ 510(k)摘要：K123465',
                        panel.conservative
                          ? '+ 处理：保留差异，暂不选择正确编号'
                          : '+ 处理：将 K123465 作为笔误记录，候选统一为 K123456',
                        '+ 原始资料保持不变，正确编号待核对',
                      ]
                    : [
                        '+ 企业注册状态：适用年度待核对',
                        '+ 年费付款凭据：年度与金额待核对',
                        '+ 美国代理人协议：有效期待核对',
                        '+ 核对提醒：每周一',
                        '+ 内部催办：王敏',
                      ]
                  ).map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                </div>
                <button className="text-button" onClick={() => openPanel('review', panel.project)}>
                  返回审核
                </button>
              </>
            ) : panel.kind === 'file' ? (
              <>
                <h3 className="filename">AGENTS.md</h3>
                <SafeMarkdown>{`本项目由${drawerMetadata.agent}处理。\n\n先读取项目说明和相关技能，列出计划，核对原文并逐步汇报；判断按当前权限模式处理，最后提交审核。\n\n${panel.project === 'registration' ? '资料：对比器械对照表、510(k)摘要。' : '资料：企业注册记录、年费付款凭据、美国代理人协议。'}`}</SafeMarkdown>
              </>
            ) : (
              <>
                <p>执行方式：按当前对话的权限模式处理。</p>
                <p>已用时间：{duration(drawerThread.elapsed)}</p>
                <p>资料读取：{sources[panel.project].length}份</p>
                <p>工作区版本：第{panel.version}版</p>
                <p className="secondary">过程摘要保留在对话中；参数原文默认收起。</p>
              </>
            )}
          </div>
          {panel.kind === 'review' && (
            <footer className="review-actions" aria-label="审核操作">
              {drawerThread.phase === 'approved' ? (
                <p className="approved-state">
                  <Icon name="check" />
                  审核已通过
                </p>
              ) : drawerThread.phase === 'returned' || drawerThread.phase === 'transferred' ? (
                <p>{phaseText[drawerThread.phase]}</p>
              ) : (
                <>
                  <div className="review-action-buttons">
                    <button
                      className="primary-button"
                      onClick={approve}
                      disabled={stale || drawerThread.phase !== 'review'}
                    >
                      通过
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() => {
                        setDecision('return');
                        setDecisionReason('');
                      }}
                      disabled={stale || drawerThread.phase !== 'review'}
                    >
                      退回修改
                    </button>
                    <details className="more-actions">
                      <summary>更多操作</summary>
                      <div>
                        {(['amend', 'question', 'transfer'] as const).map((action) => (
                          <button
                            key={action}
                            onClick={() => {
                              setDecision(action);
                              setDecisionReason('');
                            }}
                          >
                            {action === 'amend'
                              ? '修改后通过'
                              : action === 'question'
                                ? '追问'
                                : '转交他人'}
                          </button>
                        ))}
                      </div>
                    </details>
                  </div>
                  {decision && (
                    <div className="reason-form">
                      <label htmlFor="review-reason">
                        {decision === 'return'
                          ? '退回原因'
                          : decision === 'amend'
                            ? '修改意见'
                            : decision === 'question'
                              ? '追问内容'
                              : '转交说明'}
                      </label>
                      {decision === 'transfer' && <p className="secondary">转交给王敏</p>}
                      <textarea
                        id="review-reason"
                        value={decisionReason}
                        onChange={(event) => setDecisionReason(event.target.value)}
                      />
                      <button
                        className="secondary-button"
                        disabled={!decisionReason.trim() || stale}
                        onClick={decide}
                      >
                        {decision === 'return'
                          ? '确认退回'
                          : decision === 'amend'
                            ? '记录修改并通过'
                            : decision === 'question'
                              ? '发送追问'
                              : '确认转交'}
                      </button>
                    </div>
                  )}
                </>
              )}
            </footer>
          )}
        </aside>
      )}
      <Dialog.Root modal={false} open={searchOpen} onOpenChange={setSearchOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            className="dialog-content search-dialog"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              searchInput.current?.focus();
            }}
          >
            <div className="dialog-title-row">
              <Dialog.Title>搜索</Dialog.Title>
              <Dialog.Close className="icon-button" aria-label="关闭搜索">
                <Icon name="close" />
              </Dialog.Close>
            </div>
            <Dialog.Description className="secondary">查找项目、事项或对话。</Dialog.Description>
            <input
              ref={searchInput}
              aria-label="搜索项目或对话"
              placeholder="搜索项目或对话"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {(['registration', 'maintenance'] as const)
              .filter((key) =>
                `${projects[key].name}${projects[key].conversation}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              )
              .map((key) => (
                <button
                  className="search-result"
                  key={key}
                  onClick={() => {
                    openProject(key);
                    setSearchOpen(false);
                  }}
                >
                  <Icon name="folder" />
                  <span>
                    {projects[key].name}
                    <small>{projects[key].conversation}</small>
                  </span>
                </button>
              ))}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root modal={false} open={settingsOpen} onOpenChange={setSettingsOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <div className="dialog-title-row">
              <Dialog.Title>设置</Dialog.Title>
              <Dialog.Close className="icon-button" aria-label="关闭设置">
                <Icon name="close" />
              </Dialog.Close>
            </div>
            <Dialog.Description className="secondary">账户与使用偏好。</Dialog.Description>
            <p>当前成员：张三</p>
            <p>显示时区：北京时间</p>
            <button
              className="text-button"
              onClick={() => setNotice('维护页尚未接入，可在后续版本管理用户、模型和预算。')}
            >
              打开维护页
            </button>
            {notice && (
              <p role="status" className="secondary">
                {notice}
              </p>
            )}
            <p className="development-note">
              开发环境：界面稿待确认，所有资料和人物均为虚构示例；仅本地交互，不调用模型或后端，不向真实对象发送消息。
            </p>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root
        modal={false}
        open={feedbackReason !== null}
        onOpenChange={(open) => {
          if (!open) setFeedbackReason(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <div className="dialog-title-row">
              <Dialog.Title>反馈</Dialog.Title>
              <Dialog.Close className="icon-button" aria-label="关闭反馈">
                <Icon name="close" />
              </Dialog.Close>
            </div>
            <Dialog.Description className="secondary">
              说明哪一处没有帮助，方便调整。
            </Dialog.Description>
            <label htmlFor="feedback-text">反馈原因</label>
            <textarea
              id="feedback-text"
              value={feedbackText}
              onChange={(event) => setFeedbackText(event.target.value)}
            />
            <button
              className="primary-button"
              onClick={() => {
                if (feedbackReason !== null)
                  update(project, (current) => ({
                    ...current,
                    feedback: { ...current.feedback, [feedbackReason]: '已记录反馈' },
                  }));
                setFeedbackReason(null);
              }}
            >
              提交反馈
            </button>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
function ReviewSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="review-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
