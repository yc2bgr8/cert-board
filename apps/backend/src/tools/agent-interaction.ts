import { agentPlanSchema, agentQuestionSchema } from '@cert-board/shared';
import type { ToolDefinition } from './registry.js';

export function agentInteractionTools(): ToolDefinition[] {
  return [
    {
      metadata: {
        name: 'plan_update',
        version: 'builtin-plan-v1',
        publication: 'published',
        effect: 'read',
        modes: ['ask', 'full'],
        approvalInAsk: false,
        authorizationAction: 'conversation.write',
        outputDataLevel: 'internal',
        description: {
          purpose: '把有界的任务计划和当前进度登记为对话事件。',
          whenToUse: '任务开始时列步骤，每完成一步更新计划并汇报进度。',
          avoid: '业务写入、工作区保存和批准都用各自的登记入口。',
          parameters:
            'steps 按顺序列 title 和 status（pending、running 或 completed），最多 12 个，最多一个 running。progress 用一句话说明当前进度和下一步。',
          example: {
            steps: [{ title: '查找并阅读对照资料', status: 'running' }],
            progress: '已阅读项目说明，开始查找原文。',
          },
        },
      },
      inputSchema: agentPlanSchema,
      outputSchema: agentPlanSchema,
      async execute(_ctx, data) {
        return { data, dataLevel: 'internal' };
      },
    },
    {
      metadata: {
        name: 'ask_user',
        version: 'builtin-question-v1',
        publication: 'published',
        effect: 'read',
        modes: ['read_only', 'ask', 'full'],
        approvalInAsk: false,
        authorizationAction: 'conversation.write',
        outputDataLevel: 'internal',
        description: {
          purpose: '记录需要发起人回答的问题并暂停本轮。',
          whenToUse:
            '缺少关键事实、证据冲突或需要确认关键判断时，集中提出具体问题，等待发起人回答。',
          avoid: '业务调用需要批准时照常调用对应工具由后端登记。最终报告用 submit_for_review。',
          parameters:
            'question 包含必要上下文和需要回答的事项，options 是最多六个清晰选项，可留空让对方自由回答。',
          example: {
            question: '两处原文的编号不同。是否先把它登记为待确认差异并保留两处写法？',
            options: ['保留两处写法', '我补充原始资料后继续'],
          },
        },
      },
      inputSchema: agentQuestionSchema,
      outputSchema: agentQuestionSchema,
      async execute(_ctx, data) {
        return { data, dataLevel: 'internal' };
      },
    },
  ];
}
