import type { ReactNode } from 'react';
import { ShellIcon } from './ShellIcon.js';

export function ProjectShell({
  title,
  conversationTitle,
  sidebarVisible,
  onOpenSidebar,
  children,
}: {
  title: string;
  conversationTitle?: string;
  sidebarVisible: boolean;
  onOpenSidebar(): void;
  children: ReactNode;
}) {
  return (
    <main className="live-main-column">
      <header className="live-project-header">
        {!sidebarVisible && (
          <button
            className="live-icon-button"
            type="button"
            aria-label="展开侧栏"
            onClick={onOpenSidebar}
          >
            <ShellIcon name="panel" />
          </button>
        )}
        <h1 title={title}>{title}</h1>
        {conversationTitle && (
          <span className="live-conversation-title" title={conversationTitle}>
            {conversationTitle}
          </span>
        )}
        {conversationTitle && (
          <nav className="live-project-tabs" aria-label="项目内容">
            <span aria-current="page">对话</span>
            <button type="button" disabled title="文件入口尚未开放">
              文件
            </button>
            <button type="button" disabled title="资料入口尚未开放">
              资料
            </button>
          </nav>
        )}
      </header>
      <div className="live-main-content">{children}</div>
    </main>
  );
}
