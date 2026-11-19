import type { AgentCode, ExternalModelConversation, ProjectRecord } from '@cert-board/shared';
import type { ConversationDetail } from './api.js';
import { ShellIcon } from './ShellIcon.js';
import { Logo } from './Logo.js';

const agents = [
  { code: 'registration', label: '注册Agent', icon: 'clipboard' },
  { code: 'maintenance', label: '维护Agent', icon: 'wrench' },
] as const;

type Props = {
  visible: boolean;
  agent: AgentCode;
  newConversation: boolean;
  projects: ProjectRecord[];
  projectsLoading: boolean;
  projectsError: boolean;
  hasMoreProjects: boolean;
  loadMoreProjects(): void;
  retryProjects(): void;
  conversations: ConversationDetail[];
  conversationsLoading: boolean;
  conversationsError: boolean;
  hasMoreConversations: boolean;
  loadMoreConversations(): void;
  unassigned: ConversationDetail[];
  hasMoreUnassigned: boolean;
  loadMoreUnassigned(): void;
  projectId: string | null;
  conversationId: string | null;
  inbox: boolean;
  count: number;
  truncated: boolean;
  displayName: string;
  external: boolean;
  externalId: string | null;
  externalConversations: readonly ExternalModelConversation[];
  externalLoading: boolean;
  externalHasMore: boolean;
  externalLoadingMore: boolean;
  externalError: string | null;
  onProject(projectId: string): void;
  onAgent(agent: AgentCode): void;
  onConversation(conversation: ConversationDetail): void;
  onNew(): void;
  onSearch(): void;
  onInbox(): void;
  onSettings(): void;
  onExternal(): void;
  onExternalConversation(id: string): void;
  onExternalNew(): void;
  onExternalMore(): void;
  onClose(): void;
};
export function Sidebar(props: Props) {
  const unassigned = props.unassigned.filter(
    (conversation) => conversation.agentCode === props.agent,
  );
  const group = (type: 'registration' | 'maintenance', name: string) => (
    <section className="live-project-group" aria-label={name}>
      <h2>{name}</h2>
      {props.projects
        .filter((project) => project.projectType === type)
        .map((project) => (
          <div key={project.id}>
            <button
              className={`live-nav-item${project.id === props.projectId && !props.inbox ? ' is-selected' : ''}`}
              type="button"
              onClick={() => props.onProject(project.id)}
              title={project.name}
            >
              <span
                className={
                  project.id === props.projectId && !props.inbox
                    ? 'live-project-arrow is-open'
                    : 'live-project-arrow'
                }
              >
                <ShellIcon name="chevron" />
              </span>
              <span>{project.name}</span>
            </button>
            {props.projectId === project.id && !props.inbox && (
              <div className="live-project-threads">
                {props.conversationsLoading && (
                  <p className="live-nav-note" role="status">
                    正在加载对话…
                  </p>
                )}
                {props.conversationsError && (
                  <p className="live-nav-note">对话暂时无法加载，请在项目中重试。</p>
                )}
                {props.conversations.map((conversation) => (
                  <button
                    type="button"
                    key={conversation.id}
                    className={`live-thread-item${props.conversationId === conversation.id ? ' is-selected' : ''}`}
                    aria-current={props.conversationId === conversation.id ? 'page' : undefined}
                    aria-label={`切换到对话：${conversation.title}`}
                    title={conversation.title}
                    onClick={() => props.onConversation(conversation)}
                  >
                    {conversation.title}
                  </button>
                ))}
                {props.hasMoreConversations && (
                  <button
                    className="live-nav-note live-text-button"
                    type="button"
                    onClick={props.loadMoreConversations}
                  >
                    加载更多对话
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      {!props.projectsLoading &&
        !props.projectsError &&
        !props.projects.some((project) => project.projectType === type) && (
          <p className="live-nav-note">
            {props.hasMoreProjects
              ? '当前列表暂无项目'
              : type === 'registration'
                ? '暂无注册项目'
                : '暂无维护事项'}
          </p>
        )}
    </section>
  );
  return (
    <aside className="live-sidebar" aria-label="项目导航" hidden={!props.visible}>
      <div className="live-sidebar-brand">
        <Logo />
        <button
          className="live-icon-button"
          type="button"
          aria-label="收起侧栏"
          data-sidebar-toggle
          onClick={props.onClose}
        >
          <ShellIcon name="panel" />
        </button>
      </div>
      <div className="live-sidebar-top">
        <button
          className="live-create-shortcut"
          type="button"
          aria-current={props.newConversation ? 'page' : undefined}
          onClick={props.onNew}
        >
          <ShellIcon name="plus" />
          新对话
        </button>
        <button
          className="live-search-shortcut"
          type="button"
          aria-label="搜索"
          title="搜索（Ctrl+K）"
          onClick={props.onSearch}
        >
          <ShellIcon name="search" />
        </button>
      </div>
      <button
        className={`live-nav-item live-inbox-link${props.inbox ? ' is-selected' : ''}`}
        type="button"
        onClick={props.onInbox}
      >
        <ShellIcon name="inbox" />
        待我处理
        {props.count > 0 && (
          <span className="live-pending-count">
            {props.count}
            {props.truncated ? '+' : ''}
          </span>
        )}
      </button>
      <section className="live-agent-group" aria-label="助手">
        <h2>助手</h2>
        {agents.map(({ code, label, icon }) => (
          <button
            key={code}
            className="live-agent-button"
            type="button"
            aria-pressed={!props.external && props.agent === code}
            onClick={() => props.onAgent(code)}
          >
            <span>
              <ShellIcon name={icon} />
            </span>
            {label}
          </button>
        ))}
        <button
          type="button"
          className="live-agent-button"
          aria-label="外部模型"
          aria-pressed={props.external}
          onClick={props.onExternal}
        >
          <span>
            <ShellIcon name="sparkle" />
          </span>
          外部模型
          <small className="external-sidebar-badge" aria-hidden="true">
            外部
          </small>
        </button>
      </section>
      <div className="live-navigation-scroll">
        {props.external ? (
          <section className="live-project-group" aria-label="外部核实记录">
            <div className="external-sidebar-heading">
              <h2>核实记录</h2>
              <button
                type="button"
                className="live-icon-button"
                aria-label="发起外部核实"
                onClick={props.onExternalNew}
              >
                <ShellIcon name="plus" />
              </button>
            </div>
            {props.externalLoading && (
              <p className="live-nav-note" role="status">
                正在加载对话…
              </p>
            )}
            {props.externalError && (
              <p className="live-nav-note" role="alert">
                {props.externalError}
              </p>
            )}
            {props.externalConversations.map((conversation) => (
              <button
                type="button"
                key={conversation.id}
                aria-label={`打开核实：${conversation.title}`}
                aria-current={props.externalId === conversation.id ? 'page' : undefined}
                className={`live-thread-item${props.externalId === conversation.id ? ' is-selected' : ''}`}
                onClick={() => props.onExternalConversation(conversation.id)}
              >
                {conversation.title}
              </button>
            ))}
            {props.externalHasMore && (
              <button
                type="button"
                className="live-text-button"
                disabled={props.externalLoadingMore}
                onClick={props.onExternalMore}
              >
                加载更多核实记录
              </button>
            )}
          </section>
        ) : (
          <>
            {props.projectsLoading && (
              <p className="live-nav-note" role="status">
                正在加载项目…
              </p>
            )}
            {props.projectsError && (
              <div className="live-nav-note">
                <p>项目暂时无法加载。</p>
                <button className="live-text-button" type="button" onClick={props.retryProjects}>
                  重试项目列表
                </button>
              </div>
            )}
            {group(props.agent, props.agent === 'registration' ? '注册项目' : '维护事项')}
            {(unassigned.length > 0 || props.hasMoreUnassigned) && (
              <section className="live-project-group" aria-label="未关联项目的对话">
                <h2>未关联项目</h2>
                {unassigned.map((conversation) => (
                  <button
                    className={`live-thread-item${props.conversationId === conversation.id ? ' is-selected' : ''}`}
                    type="button"
                    key={conversation.id}
                    aria-label={`切换到对话：${conversation.title}`}
                    onClick={() => props.onConversation(conversation)}
                  >
                    {conversation.title}
                  </button>
                ))}
                {props.hasMoreUnassigned && (
                  <button
                    className="live-nav-note live-text-button"
                    type="button"
                    onClick={props.loadMoreUnassigned}
                  >
                    加载更多未关联对话
                  </button>
                )}
              </section>
            )}
            {props.hasMoreProjects && (
              <button
                className="live-nav-note live-text-button"
                type="button"
                onClick={props.loadMoreProjects}
              >
                加载更多项目
              </button>
            )}
          </>
        )}
      </div>
      <div className="live-sidebar-footer">
        <span className="live-member-avatar" aria-hidden="true">
          {[...props.displayName.trim()][0] ?? '?'}
        </span>
        <span title={props.displayName}>{props.displayName}</span>
        <button className="live-settings-button" type="button" onClick={props.onSettings}>
          <ShellIcon name="settings" />
          设置
        </button>
      </div>
    </aside>
  );
}
