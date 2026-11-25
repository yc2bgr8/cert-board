import { workScheduleInputSchema, workScheduleOutputSchema } from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { calculateWorkSchedule } from '../projects/work-schedule.js';
import type { ToolDefinition } from './registry.js';

export function workScheduleTool(): ToolDefinition {
  return {
    metadata: {
      name: 'work_schedule_calculate',
      version: 'builtin-work-schedule-v1',
      publication: 'published',
      effect: 'read',
      modes: ['read_only', 'ask', 'full'],
      approvalInAsk: false,
      outputDataLevel: 'dynamic',
      authorizationAction: 'project.read',
      description: {
        purpose: '从项目目标日期和节点前置关系计算日历日倒排计划、关键路径和最晚开始日。',
        whenToUse: '注册人员提供目标日期后，需要核对计划工期和最早开始条件。',
        avoid:
          '本工具只计算候选安排。实际完成日期须查项目资料；法定期限用 deadline_calc。不要为缺失事实编造工期或负责人。',
        parameters:
          'targetDate 是注册人员提供的日期；earliestStartDate 可省略。每个节点提供唯一 id、name、owner、durationDays、dependsOn。工期按日历日计算，零日表示里程碑，节点总数上限 30。结果列出最晚安排和一条关键路径。',
        example: {
          targetDate: '2030-01-10',
          earliestStartDate: '2030-01-02',
          nodes: [
            { id: 'report', name: '核对报告', owner: '示例负责人', durationDays: 2, dependsOn: [] },
            {
              id: 'review',
              name: '材料内部审核',
              owner: '示例审核人',
              durationDays: 0,
              dependsOn: ['report'],
            },
          ],
        },
      },
    },
    inputSchema: workScheduleInputSchema,
    outputSchema: workScheduleOutputSchema,
    async execute(ctx, input) {
      if (!ctx.projectId)
        throw new AppError(403, 'WORK_SCHEDULE_PROJECT_REQUIRED', '请先进入当前注册项目。');
      return { data: calculateWorkSchedule(input), dataLevel: ctx.maxDataLevel };
    },
    async refreshDataLevel(ctx) {
      return ctx.maxDataLevel;
    },
  };
}
