import { useRef, useState, type RefObject } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { ProjectRecord } from '@cert-board/shared';
import type { ConversationDetail } from './api.js';
import { ShellIcon } from './ShellIcon.js';

function highlight(value: string, search: string) {
  const start = search ? value.toLocaleLowerCase().indexOf(search) : -1;
  if (start < 0) return value;
  return (
    <>
      {value.slice(0, start)}
      <mark>{value.slice(start, start + search.length)}</mark>
      {value.slice(start + search.length)}
    </>
  );
}

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
  const [activeIndex, setActiveIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const search = query.trim().toLocaleLowerCase();
  const projectMatches = projects.filter((project) =>
    project.name.toLocaleLowerCase().includes(search),
  );
  const conversationMatches = conversations.filter((conversation) =>
    conversation.title.toLocaleLowerCase().includes(search),
  );
  const resultCount = conversationMatches.length + projectMatches.length;
  const selected = Math.min(activeIndex, resultCount - 1);
  function choose(index: number) {
    const thread = conversationMatches[index];
    const project = projectMatches[index - conversationMatches.length];
    if (thread) onConversation(thread);
    else if (project) onProject(project.id);
    else return;
    onOpenChange(false);
  }

  return (
    <Dialog.Root modal={false} open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <div className="live-search-scrim" aria-hidden="true" />
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
          <Dialog.Title className="sr-only">搜索项目或对话</Dialog.Title>
          <Dialog.Description className="sr-only">
            查找项目名和已加载的对话标题。
          </Dialog.Description>
          <div className="live-search-bar">
            <ShellIcon name="search" />
            <input
              ref={input}
              aria-label="搜索项目或对话"
              aria-controls="live-search-results"
              aria-activedescendant={selected >= 0 ? `live-search-option-${selected}` : undefined}
              placeholder="输入项目名或对话标题"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229 || resultCount === 0)
                  return;
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  const offset = event.key === 'ArrowDown' ? 1 : -1;
                  setActiveIndex((selected + offset + resultCount) % resultCount);
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  choose(selected);
                }
              }}
            />
            <Dialog.Close className="live-search-escape" aria-label="关闭搜索">
              <kbd>Esc</kbd>
            </Dialog.Close>
          </div>
          <div id="live-search-results" className="live-search-results">
            {conversationMatches.length > 0 && (
              <section aria-label="对话结果">
                <h3>对话</h3>
                {conversationMatches.map((conversation, index) => (
                  <button
                    id={`live-search-option-${index}`}
                    className={
                      selected === index ? 'live-search-result is-current' : 'live-search-result'
                    }
                    type="button"
                    key={conversation.id}
                    onFocus={() => setActiveIndex(index)}
                    onClick={() => choose(index)}
                  >
                    <ShellIcon name="chat" />
                    <span>
                      {highlight(conversation.title, search)}
                      <small>
                        {projects.find((project) => project.id === conversation.projectId)?.name ??
                          conversation.ownerName}
                      </small>
                    </span>
                  </button>
                ))}
              </section>
            )}
            {projectMatches.length > 0 && (
              <section aria-label="项目结果">
                <h3>项目</h3>
                {projectMatches.map((project, projectIndex) => {
                  const index = conversationMatches.length + projectIndex;
                  return (
                    <button
                      id={`live-search-option-${index}`}
                      className={
                        selected === index ? 'live-search-result is-current' : 'live-search-result'
                      }
                      type="button"
                      key={project.id}
                      onFocus={() => setActiveIndex(index)}
                      onClick={() => choose(index)}
                    >
                      <ShellIcon name="folder" />
                      <span>{highlight(project.name, search)}</span>
                    </button>
                  );
                })}
              </section>
            )}
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
            {!loading && !error && resultCount === 0 && (
              <p className="live-muted">当前列表没有匹配结果。</p>
            )}
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
          <footer className="live-search-keys">
            <span>
              <kbd>↑</kbd> <kbd>↓</kbd> 选择
            </span>
            <span>
              <kbd>Enter</kbd> 打开
            </span>
            <span>
              <kbd>Ctrl K</kbd> 随时打开搜索
            </span>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
