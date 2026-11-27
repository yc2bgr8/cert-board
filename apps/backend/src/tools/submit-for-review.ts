import { randomUUID } from 'node:crypto';
import {
  structuredSubmissionSchema,
  reviewSubmitResultSchema,
  reviewUndoStateSchema,
  agentCodeSchema,
  skillLoadInputSchema,
  type ReviewPolicy,
  type ToolMetadata,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { requireReviewPolicy } from '../reviews/policy.js';
import {
  submitReview,
  reviewVersion,
  cancelPendingReview,
  refreshReviewDataLevel,
} from '../reviews/submission.js';
import type { ToolDefinition } from './registry.js';
import { readActiveSkill } from '../skills/service.js';
import { readTaskAssignment } from '../conversations/task-catalog.js';

const metadata: ToolMetadata = {
  name: 'submit_for_review',
  version: 'builtin-review-v2',
  publication: 'published',
  effect: 'reversible_write',
  modes: ['ask', 'full'],
  approvalInAsk: false,
  outputDataLevel: 'dynamic',
  authorizationAction: 'workspace.write',
  description: {
    purpose: '把已保存的核查报告和结构化证据提交给人审核；仅建立待审核卡，不会批准或冻结版本。',
    whenToUse:
      '已按技能读取实际资料、完成报告、保存最新工作区版本并用check_run通过关键检查后使用。',
    avoid:
      '不能当作审批工具；对话中的同意不算批准。资料未读完整请先doc_read，保存冲突先合并；程序不判断正确K号或法规立场。',
    parameters:
      '直接传结构化结果的skill/workspaceVersion/conclusion/claims/decisions/evidence/missing/uncertain/nextStep。decisions必填，可显式[]；每项记录id/subject/choice/alternatives/reason/sources/risk(low或high)，至少一条原文。期限只写在claims的期限陈述中，value使用deadline_calc返回的毫秒级ISO时间点，deadlineCalculation填对应计算依据。所有判断与陈述引语都须完整出现在本对话成功doc_read回执；陈述与判断合计20条、全部引用40条。例子为虚构格式，请替换成真实定位。',
    example: {
      skill: { id: 'R09', version: '0.1.0' },
      workspaceVersion: '10000000-0000-4000-8000-000000000001',
      conclusion: '两处写法不同，需注册人员核对。',
      claims: [
        {
          id: 'C1',
          object: '示例资料',
          field: 'K号写法',
          value: 'EXAMPLE-A',
          unit: null,
          sources: [
            {
              documentId: '10000000-0000-4000-8000-000000000002',
              version: 1,
              page: 1,
              quote: 'EXAMPLE-A',
            },
          ],
          status: 'checked',
        },
      ],
      evidence: [
        {
          documentId: '10000000-0000-4000-8000-000000000002',
          version: 1,
          page: 1,
          quote: 'EXAMPLE-A',
        },
        {
          documentId: '10000000-0000-4000-8000-000000000002',
          version: 1,
          page: 1,
          quote: 'EXAMPLE-B',
        },
      ],
      decisions: [
        {
          id: 'D1',
          subject: '差异处理',
          choice: '保留两处差异，先核对原件',
          alternatives: ['将其中一处按笔误统一'],
          reason: '两处引文不足以认定正确编号。',
          sources: [
            {
              documentId: '10000000-0000-4000-8000-000000000002',
              version: 1,
              page: 1,
              quote: 'EXAMPLE-A',
            },
            {
              documentId: '10000000-0000-4000-8000-000000000002',
              version: 1,
              page: 1,
              quote: 'EXAMPLE-B',
            },
          ],
          risk: 'high',
        },
      ],
      missing: [],
      uncertain: ['正确编号待确认。'],
      nextStep: '请核对原件后在审核卡作出决定。',
    },
  },
};

export function submitForReviewTool(policyInput: ReviewPolicy): ToolDefinition {
  const policy = requireReviewPolicy(policyInput);
  return {
    metadata,
    inputSchema: structuredSubmissionSchema,
    outputSchema: reviewSubmitResultSchema,
    async execute(ctx, input, before) {
      if (!before || before.targetType !== 'review_card' || before.beforeVersion !== null)
        throw new AppError(
          403,
          'REVIEW_UNDO_REQUIRED',
          '提交审核缺少已登记的撤销记录，已拒绝建立卡片。',
        );
      const current = structuredSubmissionSchema.parse(input);
      const selected = skillLoadInputSchema.safeParse(current.skill);
      const task = await readTaskAssignment(ctx.tx, ctx.conversationId, ctx.actor.userId);
      if (
        task &&
        (!selected.success ||
          selected.data.id !== task.code ||
          selected.data.version !== task.skillVersion)
      )
        throw new AppError(
          422,
          'TOOL_INPUT_INVALID',
          `请按已交办的技能 ${task.code}@${task.skillVersion} 核对并提交审核。`,
        );
      const data = (
        await ctx.tx.query<{ agent_code: string }>(
          'SELECT agent_code FROM conversation WHERE id=$1 AND user_id=$2',
          [ctx.conversationId, ctx.actor.userId],
        )
      ).rows[0];
      const code = agentCodeSchema.parse(data?.agent_code);
      const stored = selected.success
        ? await readActiveSkill(ctx.tx, code, selected.data, ctx.permissionMode)
        : undefined;
      if (stored === null)
        throw new AppError(
          409,
          'SKILL_VERSION_CONFLICT',
          '提交所用技能已停用或版本已变更，请按当前生效技能重新核对。',
        );
      const unresolved = await ctx.tx.query(
        `SELECT 1 FROM verification_wait w JOIN run r ON r.id=w.run_id
          JOIN verification_post original_question ON original_question.room_id=w.room_id AND original_question.position=1
          WHERE r.goal_id=$1 AND w.conversation_id=$2 AND w.user_id=$3
          AND w.fallback AND w.receipt IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM verification_wait newer JOIN verification_post question
              ON question.room_id=newer.room_id AND question.position=1
            WHERE newer.conversation_id=w.conversation_id AND newer.user_id=w.user_id
              AND newer.created_at>w.created_at AND NOT newer.fallback AND newer.receipt->>'status'='completed'
              AND lower(btrim(regexp_replace(normalize(question.text), '[[:space:]]+', ' ', 'g')))
                =lower(btrim(regexp_replace(normalize(original_question.text), '[[:space:]]+', ' ', 'g')))
          ) LIMIT 1`,
        [ctx.goalId, ctx.conversationId, ctx.actor.userId],
      );
      const pending = '外部核实待确认。此次核实未取得可用结论，审核时请核对这一项。';
      if (unresolved.rowCount && !current.uncertain.includes(pending)) {
        if (current.uncertain.length >= 20)
          throw new AppError(
            422,
            'VERIFICATION_UNCERTAINTY_REQUIRED',
            '请合并已有不确定事项，为「外部核实待确认」留出一项再送审。',
          );
        current.uncertain.push(pending);
      }
      return submitReview(ctx, current, before.targetId, stored?.reviewPolicy ?? policy);
    },
    refreshDataLevel: refreshReviewDataLevel,
    undo: {
      beforeSchema: reviewUndoStateSchema,
      async capture() {
        return {
          targetType: 'review_card',
          targetId: randomUUID(),
          beforeState: { created: false },
          beforeVersion: null,
        };
      },
      currentVersion: (ctx, record) => reviewVersion(ctx, record.targetId),
      apply: cancelPendingReview,
    },
  };
}
