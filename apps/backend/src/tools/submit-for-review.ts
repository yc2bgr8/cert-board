import { randomUUID } from 'node:crypto';
import {
  structuredSubmissionSchema,
  reviewSubmitResultSchema,
  reviewUndoStateSchema,
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
      return submitReview(ctx, input, before.targetId, policy);
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
