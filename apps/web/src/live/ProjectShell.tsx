import type { ReactNode } from 'react';
import { ShellIcon } from './ShellIcon.js';

export function ProjectShell({
  title,
  conversationTitle,
  sidebarVisible,
  onOpenSidebar,
  tab = 'conversation',
  onTabChange,
  showTabs = false,
  children,
}: {
  title: string;
  conversationTitle?: string;
  sidebarVisible: boolean;
  onOpenSidebar(): void;
  tab?: 'conversation' | 'files' | 'documents';
  onTabChange?(tab: 'conversation' | 'files' | 'documents'): void;
  showTabs?: boolean;
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
        {showTabs && (
          <nav className="live-project-tabs" aria-label="项目内容">
            {(['conversation', 'files', 'documents'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-current={tab === value ? 'page' : undefined}
                onClick={() => onTabChange?.(value)}
              >
                {{ conversation: '对话', files: '文件', documents: '资料' }[value]}
              </button>
            ))}
          </nav>
        )}
      </header>
      <div className="live-main-content">{children}</div>
    </main>
  );
}
