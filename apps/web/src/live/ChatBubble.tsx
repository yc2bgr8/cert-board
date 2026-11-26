// 来源：VisaFlow/app/packages/ui/src/components/chat/UserMessageBubble.tsx
// Apache-2.0，已修改为使用 cert-board 的会话消息。
import { SafeMarkdown } from '../SafeMarkdown.js';
import type { LiveMessage } from './events.js';
import { ShellIcon } from './ShellIcon.js';
import { splitConversationDraft } from './conversation-draft.js';

const clock = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function ChatBubble({
  message,
  agentName,
  maintenance,
}: {
  message: LiveMessage;
  agentName: string;
  maintenance: boolean;
}) {
  if (message.role === 'user') {
    const { body, references } = splitConversationDraft(message.text);
    return (
      <div className="live-user-message">
        {references.length > 0 && (
          <div className="live-message-references" aria-label="引用资料">
            {references.map(({ line, label, version }, index) => (
              <span className="live-composer-reference" title={line} key={`${line}-${index}`}>
                <ShellIcon name="file" />
                <span>
                  {label} · 第 {version} 版
                </span>
              </span>
            ))}
          </div>
        )}
        {body && <p>{body}</p>}
      </div>
    );
  }
  return (
    <article className="live-agent-message">
      <header className="live-agent-message-heading">
        <span className="live-agent-message-mark">
          <ShellIcon name={maintenance ? 'wrench' : 'clipboard'} />
        </span>
        <strong>{agentName}</strong>
        <time dateTime={message.createdAt}>{clock.format(new Date(message.createdAt))}</time>
      </header>
      <div className="live-agent-message-body">
        <SafeMarkdown workbench>{message.text}</SafeMarkdown>
      </div>
    </article>
  );
}
