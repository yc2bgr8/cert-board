// 来源：VisaFlow/app/packages/ui/src/components/chat/InlineExecution.tsx
// Apache-2.0，已修改为读取 cert-board 已公开的工具步骤。
// Layout adapted from Orca NativeChatToolRun at bc8085021b0a7e046925901a2f857361dd929686.
// Copyright (c) 2026 Lovecast Inc. MIT. See third_party/orca/LICENSE.
import type { LiveToolStep } from './events.js';
import { ShellIcon } from './ShellIcon.js';

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
        <span className="live-tool-chevron">
          <ShellIcon name="chevron" />
        </span>
        <ShellIcon name="activity" />
        <span className="live-tool-label">工具过程</span>
        <span className="live-conversation-meta">{activities.length} 项</span>
      </summary>
      <ol>
        {activities.map((activity) => (
          <li key={activity.id}>
            <span className={`live-step-mark live-step-${activity.status}`} aria-hidden="true">
              {activityMarks[activity.status]}
            </span>
            <span className="live-tool-step-name">{activity.summary || activity.name}</span>
            <span className={`live-tool-step-status live-step-${activity.status}`}>
              {toolStateNames[activity.status]}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}
