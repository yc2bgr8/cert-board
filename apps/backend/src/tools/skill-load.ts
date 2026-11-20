import { agentCodeSchema, skillLoadInputSchema, skillLoadResultSchema } from '@cert-board/shared';
import { loadSelectedSkill } from '../agent/definitions.js';
import { AppError } from '../api/errors.js';
import type { ToolDefinition } from './registry.js';

export function skillLoadTool(): ToolDefinition {
  return {
    metadata: {
      name: 'skill_load',
      version: 'builtin-skill-load-v1',
      publication: 'published',
      effect: 'read',
      modes: ['read_only', 'ask', 'full'],
      approvalInAsk: false,
      outputDataLevel: 'internal',
      authorizationAction: 'conversation.read',
      description: {
        purpose: '按当前 Agent 的生效技能索引加载正文、检查要求和附件清单。',
        whenToUse: '开始项目任务前，先从系统提示的技能索引选择适用技能再读取。',
        avoid: '不加载文件路径、其他Agent技能或未登记版本；不能把草稿说成已发布或已经执行的能力。',
        parameters:
          'id取当前Agent索引中的技能编号；version可省略以采用索引版本。所属Agent由对话数据库字段决定，不能在参数中改选。附件清单为空时不能编造附件。',
        example: { id: 'R09', version: '0.1.0' },
      },
    },
    inputSchema: skillLoadInputSchema,
    outputSchema: skillLoadResultSchema,
    async execute(ctx, input) {
      const row = (
        await ctx.tx.query<{ agent_code: string }>(
          'SELECT agent_code FROM conversation WHERE id=$1 AND user_id=$2 AND project_id IS NOT DISTINCT FROM $3::uuid',
          [ctx.conversationId, ctx.actor.userId, ctx.projectId],
        )
      ).rows[0];
      const code = agentCodeSchema.safeParse(row?.agent_code);
      if (!code.success)
        throw new AppError(
          403,
          'SKILL_CONTEXT_INVALID',
          '当前对话的Agent归属无效，请重新进入项目。',
        );
      return {
        data: await loadSelectedSkill(ctx.tx, code.data, input, ctx.permissionMode),
        dataLevel: 'internal',
      };
    },
  };
}
