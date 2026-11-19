import { useEffect, useRef, useState, type RefObject } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { ProjectRecord } from '@cert-board/shared';
import { api, type ConversationDetail } from './api.js';
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
  userId,
  onVerification,
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
  userId: string;
  onVerification(id: string): void;
}) {
  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const search = query.trim().toLocaleLowerCase();
  const verification = useInfiniteQuery({
    queryKey: ['live', 'verification-search', userId, search],
    queryFn: ({ signal, pageParam }) => api.verificationRooms(pageParam, search, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: open && search.length > 0,
    retry: false,
  });
  const verificationMatches = verification.data?.pages.flatMap(({ items }) => items) ?? [];
  const projectMatches = projects.filter((project) =>
    project.name.toLocaleLowerCase().includes(search),
  );
  const conversationMatches = conversations.filter((conversation) =>
    conversation.title.toLocaleLowerCase().includes(search),
  );
  const optionKeys = [
    ...conversationMatches.map((conversation) => `conversation-${conversation.id}`),
    ...projectMatches.map((project) => `project-${project.id}`),
    ...verificationMatches.map((room) => `verification-${room.id}`),
  ];
  const resultCount = optionKeys.length;
  const selectedKey = activeKey && optionKeys.includes(activeKey) ? activeKey : optionKeys[0];
  const selected = selectedKey ? optionKeys.indexOf(selectedKey) : -1;
  const activeOptionId = selectedKey ? `live-search-option-${selectedKey}` : undefined;
  useEffect(() => {
    if (!open || !activeOptionId) return;
    setActiveKey(selectedKey);
    document.getElementById(activeOptionId)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeOptionId, selectedKey, query]);
  function choose(index: number) {
    const thread = conversationMatches[index];
    const project = projectMatches[index - conversationMatches.length];
    const verificationRoom =
      verificationMatches[index - conversationMatches.length - projectMatches.length];
    if (thread) onConversation(thread);
    else if (project) onProject(project.id);
    else if (verificationRoom) onVerification(verificationRoom.id);
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
            查找项目名、对话标题和核实记录。
          </Dialog.Description>
          <div className="live-search-bar">
            <ShellIcon name="search" />
            <input
              ref={input}
              role="combobox"
              aria-label="搜索项目或对话"
              aria-expanded={open}
              aria-autocomplete="list"
              aria-controls="live-search-results"
              aria-activedescendant={activeOptionId}
              placeholder="输入项目名或对话标题"
              maxLength={100}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveKey(undefined);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229 || resultCount === 0)
                  return;
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  const offset = event.key === 'ArrowDown' ? 1 : -1;
                  setActiveKey(optionKeys[(selected + offset + resultCount) % resultCount]);
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
          <div className="live-search-results">
            <div id="live-search-results" role="listbox" aria-label="搜索结果">
              {conversationMatches.length > 0 && (
                <section role="group" aria-label="对话结果">
                  <h3 aria-hidden="true">对话</h3>
                  {conversationMatches.map((conversation, index) => (
                    <button
                      id={`live-search-option-${optionKeys[index]}`}
                      className={
                        selected === index ? 'live-search-result is-current' : 'live-search-result'
                      }
                      type="button"
                      role="option"
                      aria-selected={selected === index}
                      tabIndex={-1}
                      key={conversation.id}
                      onFocus={() => setActiveKey(optionKeys[index])}
                      onClick={() => choose(index)}
                    >
                      <ShellIcon name="chat" />
                      <span>
                        {highlight(conversation.title, search)}
                        <small>
                          {[
                            conversation.projectId
                              ? projects.find((project) => project.id === conversation.projectId)
                                  ?.name
                              : '未关联项目',
                            conversation.ownerName,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </small>
                      </span>
                    </button>
                  ))}
                </section>
              )}
              {projectMatches.length > 0 && (
                <section role="group" aria-label="项目结果">
                  <h3 aria-hidden="true">项目</h3>
                  {projectMatches.map((project, projectIndex) => {
                    const index = conversationMatches.length + projectIndex;
                    return (
                      <button
                        id={`live-search-option-${optionKeys[index]}`}
                        className={
                          selected === index
                            ? 'live-search-result is-current'
                            : 'live-search-result'
                        }
                        type="button"
                        role="option"
                        aria-selected={selected === index}
                        tabIndex={-1}
                        key={project.id}
                        onFocus={() => setActiveKey(optionKeys[index])}
                        onClick={() => choose(index)}
                      >
                        <ShellIcon name="folder" />
                        <span>{highlight(project.name, search)}</span>
                      </button>
                    );
                  })}
                </section>
              )}
              {verificationMatches.length > 0 && (
                <section role="group" aria-label="核实记录">
                  <h3 aria-hidden="true">核实记录</h3>
                  {verificationMatches.map((room, offset) => {
                    const index = conversationMatches.length + projectMatches.length + offset;
                    return (
                      <button
                        id={`live-search-option-${optionKeys[index]}`}
                        className={
                          selected === index
                            ? 'live-search-result is-current'
                            : 'live-search-result'
                        }
                        key={room.id}
                        type="button"
                        role="option"
                        aria-selected={selected === index}
                        tabIndex={-1}
                        onFocus={() => setActiveKey(optionKeys[index])}
                        onClick={() => choose(index)}
                      >
                        <ShellIcon name="sparkle" />
                        <span>
                          {highlight(room.title, search)}
                          {room.projectName && <small>{room.projectName}</small>}
                        </span>
                      </button>
                    );
                  })}
                </section>
              )}
            </div>
            {loading && (
              <p className="live-muted" role="status">
                正在加载对话…
              </p>
            )}
            {verification.isFetching && (
              <p className="live-muted" role="status">
                正在查找核实记录…
              </p>
            )}
            {verification.isError && !loading && !error && (
              <p className="live-error" role="alert">
                核实记录暂时无法查询。
              </p>
            )}
            {verification.hasNextPage && (
              <button
                type="button"
                className="live-text-button"
                disabled={verification.isFetchingNextPage}
                onClick={() => void verification.fetchNextPage()}
              >
                加载更多核实记录
              </button>
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
              !verification.isFetching &&
              !verification.isError &&
              resultCount === 0 && <p className="live-muted">当前列表没有匹配结果。</p>}
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
