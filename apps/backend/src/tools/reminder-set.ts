import { reminderInputSchema, reminderResultSchema, reminderUndoSchema } from '@cert-board/shared';
import {
  captureReminder,
  previewReminder,
  reminderVersion,
  setReminder,
  undoReminder,
} from '../deadlines/reminders.js';
import type { ToolDefinition } from './registry.js';

export function reminderSetTool(): ToolDefinition {
  return {
    metadata: {
      name: 'reminder_set',
      version: 'builtin-reminder-set-v1',
      publication: 'published',
      effect: 'reversible_write',
      modes: ['ask', 'full'],
      approvalInAsk: true,
      outputDataLevel: 'internal',
      authorizationAction: 'record.write',
      description: {
        purpose: '为当前目标的负责人设置或调整一项站内期限提醒。请求批准模式由浏览器先批准。',
        whenToUse: '期限规则、起算日期和适用时区已有依据，需要后续在工作台看到提醒。',
        avoid: '只想计算期限时用 deadline_calc。不要提交收件地址、直接外发或推测法规期限。',
        parameters:
          'title 为简短标题；profile 为 certificate（证照）或 milestone（节点）；calculation 沿用 deadline_calc 参数。',
        example: {
          title: '样例登记到期',
          profile: 'certificate',
          calculation: {
            startDate: '2026-05-01',
            quantity: 6,
            unit: 'calendar_months',
            jurisdictionTz: 'Asia/Shanghai',
          },
        },
      },
    },
    inputSchema: reminderInputSchema,
    outputSchema: reminderResultSchema,
    prepareApproval: previewReminder,
    execute: setReminder,
    undo: {
      beforeSchema: reminderUndoSchema,
      capture: captureReminder,
      currentVersion: (ctx, record) => reminderVersion(ctx, record.targetId),
      apply: undoReminder,
    },
  };
}
