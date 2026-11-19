// 来源：VisaFlow/app/packages/ui/src/components/chat/UserMessageBubble.tsx
// Apache-2.0，已修改为使用 cert-board 的会话消息。
import { SafeMarkdown } from '../SafeMarkdown.js';
import type { LiveMessage } from './events.js';
import { ShellIcon } from './ShellIcon.js';

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
  if (message.role === 'user') return <p className="live-user-message">{message.text}</p>;
  return (
    <article className="live-agent-message">
      <header className="live-agent-message-heading">
        <span className="live-agent-message-mark">
          <ShellIcon name={maintenance ? 'wrench' : 'clipboard'} />
        </span>
        <strong>{agentName}</strong>
        <time dateTime={message.createdAt}>{clock.format(new Date(message.createdAt))}</time>
      </header>
      <SafeMarkdown workbench>{message.text}</SafeMarkdown>
    </article>
  );
}
