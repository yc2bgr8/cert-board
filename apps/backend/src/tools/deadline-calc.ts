import { deadlineCalculationResultSchema, deadlineCalculationSchema } from '@cert-board/shared';
import { calculateDeadline } from '../deadlines/calendar.js';
import type { ToolDefinition } from './registry.js';

export function deadlineCalcTool(): ToolDefinition {
  return {
    metadata: {
      name: 'deadline_calc',
      version: 'builtin-deadline-calc-v1',
      publication: 'published',
      effect: 'read',
      modes: ['read_only', 'ask', 'full'],
      approvalInAsk: false,
      outputDataLevel: 'internal',
      authorizationAction: 'record.read',
      description: {
        purpose:
          '按明确的法域时区和日历起算规则计算期限，返回当地到期日、带时区的时间点和北京时间。',
        whenToUse: '已从规则或资料中确认起算日、按天或按月的数量和适用 IANA 时区时。',
        avoid:
          '遇到适用法律、工作日历或具体截止钟点不清楚的情况，先核对依据。计算后需要站内提醒时使用 reminder_set。',
        parameters:
          'startDate 为当地 YYYY-MM-DD；quantity 为整数，可为负数；unit 是 calendar_days 或 calendar_months；jurisdictionTz 使用 IANA 时区。到期点为当地日末。',
        example: {
          startDate: '2024-01-31',
          quantity: 1,
          unit: 'calendar_months',
          jurisdictionTz: 'America/New_York',
        },
      },
    },
    inputSchema: deadlineCalculationSchema,
    outputSchema: deadlineCalculationResultSchema,
    async execute(_, input) {
      return { data: calculateDeadline(input), dataLevel: 'internal' };
    },
  };
}
