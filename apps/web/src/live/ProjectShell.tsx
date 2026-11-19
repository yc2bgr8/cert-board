import type { ReactNode } from 'react';
import { ShellIcon } from './ShellIcon.js';

export function ProjectShell({
  title,
  location,
  sidebarVisible,
  onOpenSidebar,
  tab = 'conversation',
  onTabChange,
  showTabs = false,
  headerAction,
  inspector,
  children,
}: {
  title: string;
  location?: string;
  sidebarVisible: boolean;
  onOpenSidebar(): void;
  tab?: 'conversation' | 'files' | 'documents';
  onTabChange?(tab: 'conversation' | 'files' | 'documents'): void;
  showTabs?: boolean;
  headerAction?: ReactNode;
  inspector?: ReactNode;
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
            data-sidebar-toggle
            onClick={onOpenSidebar}
          >
            <ShellIcon name="panel" />
          </button>
        )}
        <div className="live-title-group">
          {location && (
            <p className="live-crumb" title={location}>
              {location}
            </p>
          )}
          <h1 title={title}>{title}</h1>
        </div>
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
        {headerAction && <div className="live-project-header-action">{headerAction}</div>}
      </header>
      <div className="live-main-row">
        <div className="live-main-content">{children}</div>
        {inspector}
      </div>
    </main>
  );
}
