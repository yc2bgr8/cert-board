import { useRef, useState, type RefObject } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { ProjectRecord } from '@cert-board/shared';
import type { ConversationDetail } from './api.js';
import { ShellIcon } from './ShellIcon.js';

export function Search({
  open,
  onOpenChange,
  projects,
  conversations,
  loading,
  error,
  retry,
  hasMore,
  loadMore,
  returnFocus,
  onProject,
  onConversation,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  projects: ProjectRecord[];
  conversations: ConversationDetail[];
  loading: boolean;
  error: string | null;
  retry(): void;
  hasMore: boolean;
  loadMore(): void;
  returnFocus: RefObject<HTMLElement | null>;
  onProject(id: string): void;
  onConversation(conversation: ConversationDetail): void;
}) {
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const search = query.trim().toLocaleLowerCase();
  return (
    <Dialog.Root modal={false} open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Content
          className="live-dialog live-search-dialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            input.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus.current?.focus();
          }}
        >
          <div className="live-dialog-heading">
            <Dialog.Title>搜索项目或对话</Dialog.Title>
            <Dialog.Close className="live-icon-button" aria-label="关闭搜索">
              <ShellIcon name="close" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="live-muted">
            查找项目名和已加载的对话标题。
          </Dialog.Description>
          <input
            ref={input}
            aria-label="搜索项目或对话"
            placeholder="输入项目名或对话标题"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="live-search-results">
            {projects
              .filter((project) => project.name.toLocaleLowerCase().includes(search))
              .map((project) => (
                <button
                  className="live-search-result"
                  type="button"
                  key={project.id}
                  onClick={() => {
                    onProject(project.id);
                    onOpenChange(false);
                  }}
                >
                  <ShellIcon name="folder" />
                  <span>{project.name}</span>
                </button>
              ))}
            {conversations
              .filter((conversation) => conversation.title.toLocaleLowerCase().includes(search))
              .map((conversation) => (
                <button
                  className="live-search-result"
                  type="button"
                  key={conversation.id}
                  onClick={() => {
                    onConversation(conversation);
                    onOpenChange(false);
                  }}
                >
                  <ShellIcon name="chat" />
                  <span>
                    {conversation.title}
                    <small>{conversation.ownerName}</small>
                  </span>
                </button>
              ))}
            {loading && (
              <p className="live-muted" role="status">
                正在加载对话…
              </p>
            )}
            {error && (
              <p className="live-error" role="alert">
                {error}{' '}
                <button className="live-text-button" type="button" onClick={retry}>
                  重新加载对话
                </button>
              </p>
            )}
            {!loading &&
              !error &&
              !projects.some((project) => project.name.toLocaleLowerCase().includes(search)) &&
              !conversations.some((conversation) =>
                conversation.title.toLocaleLowerCase().includes(search),
              ) && <p className="live-muted">当前列表没有匹配结果。</p>}
            {hasMore && (
              <button
                className="live-text-button"
                type="button"
                disabled={loading}
                onClick={loadMore}
              >
                加载更多对话再查找
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
