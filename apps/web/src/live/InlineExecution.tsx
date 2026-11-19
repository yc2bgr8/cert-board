// 来源：VisaFlow/app/packages/ui/src/components/chat/InlineExecution.tsx
// Apache-2.0，已修改为读取 cert-board 已公开的工具步骤。
import type { LiveToolStep } from './events.js';

export const toolStateNames = {
  running: '进行中',
  completed: '完成',
  failed: '失败',
  awaiting_approval: '待批准',
} as const;

const activityMarks = {
  running: '◌',
  completed: '✓',
  failed: '×',
  awaiting_approval: '◷',
} as const;

export function InlineExecution({ activities }: { activities: LiveToolStep[] }) {
  if (!activities.length) return null;
  return (
    <details className="live-tool-process">
      <summary>
        工具过程 <span className="live-conversation-meta">{activities.length} 项</span>
      </summary>
      <ol>
        {activities.map((activity) => (
          <li key={activity.id}>
            <span className={`live-step-mark live-step-${activity.status}`} aria-hidden="true">
              {activityMarks[activity.status]}
            </span>
            <span className="sr-only">{toolStateNames[activity.status]}：</span>
            <span>{activity.summary || activity.name}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
