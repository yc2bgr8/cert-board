import {
  proposalCreateSchema,
  proposalToolResultSchema,
  type ToolMetadata,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { proposalContentHash } from '../outbound/content.js';
import type { ToolDefinition, ToolExecutionContext } from './registry.js';

const metadata: ToolMetadata = {
  name: 'propose_external',
  version: 'builtin-proposal-v1',
  publication: 'published',
  effect: 'external',
  modes: ['ask', 'full'],
  approvalInAsk: false,
  outputDataLevel: 'internal',
  authorizationAction: 'record.write',
  description: {
    purpose: '为明确的外部动作建立待人工审核提案；开发环境仅支持本地测试渠道，绝不直接发送。',
    whenToUse: '用户明确要求准备对外内容，且已有本项目登记的测试联系人时使用。',
    avoid:
      '核查结果交人工审核请用submit_for_review；没有登记联系人不要猜编号；审批只能在浏览器审核卡操作。',
    parameters:
      'contactId是本项目有效登记联系人编号；subject是单行主题；body是待审核正文，不支持附件。',
    example: {
      contactId: '00000000-0000-4000-8000-000000000001',
      subject: '资料核对（虚构示例）',
      body: '请协助核对资料。此编号仅为格式示例，实际须使用登记联系人。',
    },
  },
};

export function proposeExternalTool(): ToolDefinition {
  return {
    metadata,
    inputSchema: proposalCreateSchema,
    outputSchema: proposalToolResultSchema,
    async propose(ctx: ToolExecutionContext, input: unknown) {
      const data = proposalCreateSchema.parse(input);
      if (!ctx.projectId || !ctx.goalId || ctx.goalStatus !== 'active')
        throw new AppError(403, 'PROPOSAL_GOAL_REQUIRED', '请在活动目标的执行对话中建立提案。');
      if (ctx.maxDataLevel === 'confidential')
        throw new AppError(
          403,
          'PROPOSAL_DATA_RESTRICTED',
          '保密内容不能进入当前外发测试流程，请交负责人通过内部方式处理。',
        );
      const invocation = await ctx.tx.query<{ id: string }>(
        `SELECT id FROM tool_invocation WHERE run_id=$1 AND call_id=$2 AND user_id=$3 AND conversation_id=$4 AND tool_name='propose_external' AND effect='external' AND operation='execute' AND status='started'`,
        [ctx.runId, ctx.callId, ctx.actor.userId, ctx.conversationId],
      );
      if (invocation.rowCount !== 1)
        throw new AppError(
          403,
          'PROPOSAL_REGISTERED_TOOL_REQUIRED',
          '提案必须经过已登记工具执行，不能直接写入。',
        );
      const contact = await ctx.tx.query<{
        id: string;
        version: number;
        name: string;
        address: string;
        channel: string;
      }>(
        "SELECT id,version,name,address,channel FROM contact WHERE id=$1 AND project_id=$2 AND active=true AND channel='local_test' FOR SHARE",
        [data.contactId, ctx.projectId],
      );
      const recipient = contact.rows[0];
      if (!recipient)
        throw new AppError(
          400,
          'PROPOSAL_CONTACT_INVALID',
          '没有找到本项目有效测试联系人，请先核对登记记录，不要使用自由填写的地址。',
        );
      const digest = proposalContentHash(data);
      const result = await ctx.tx.query<{ id: string; version: number }>(
        `INSERT INTO proposal(project_id,goal_id,conversation_id,run_id,invocation_id,proposed_by,contact_id,recipient_version,recipient_name,recipient_address,channel,subject,body,content_hash,data_level)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'local_test',$11,$12,$13,$14) RETURNING id,version`,
        [
          ctx.projectId,
          ctx.goalId,
          ctx.conversationId,
          ctx.runId,
          invocation.rows[0]!.id,
          ctx.actor.userId,
          recipient.id,
          recipient.version,
          recipient.name,
          recipient.address,
          data.subject,
          data.body,
          digest,
          ctx.maxDataLevel,
        ],
      );
      const proposed = result.rows[0]!;
      await ctx.tx.query(
        "INSERT INTO audit_log(actor_user_id,actor_kind,action,target_type,target_id,after_hash) VALUES($1,'agent','proposal.created','proposal',$2,$3)",
        [ctx.actor.userId, proposed.id, digest],
      );
      return {
        data: proposalToolResultSchema.parse({
          proposalId: proposed.id,
          version: proposed.version,
          status: 'proposed',
          channel: 'local_test',
          sent: false,
        }),
        dataLevel: ctx.maxDataLevel,
      };
    },
  };
}
