import { z } from 'zod';
import { evaluationStatusViewSchema } from './evaluation.js';
import {
  checkReportSchema,
  documentCitationSchema,
  structuredSubmissionSchema,
  legacyStructuredSubmissionSchema,
} from './checks.js';
import { sha256Schema } from './documents.js';
import { workspacePathSchema } from './workspace-path.js';

const id = z.string().uuid('审核卡、工作区或请求编号无效。');
const version = z.number().int().min(1).max(2147483647);
const instant = z.string().datetime({ offset: true });
const statement = z
  .string()
  .max(4000, '判断或原因最多4000字符。')
  .refine(
    (value) =>
      value.trim().length > 0 && /^[^\uD800-\uDFFF]*$/u.test(value) && !value.includes('\0'),
    '请填写非空且编码有效的判断或原因。',
  );
const skill = structuredSubmissionSchema.shape.skill;
export const reviewRiskSchema = z.enum(['standard', 'high']);
export const reviewStatusSchema = z.enum(['pending', 'approved', 'rejected', 'cancelled']);
const draftReviewPolicySchema = z
  .object({
    skill,
    publication: z.literal('draft'),
    developmentOnly: z.literal(true),
    requiredChecks: z.tuple([z.literal('V1'), z.literal('V3')]),
    minimumEvidence: z.literal(2),
    risk: reviewRiskSchema,
    cardType: z.literal('finalize'),
  })
  .strict();
const publishedReviewPolicySchema = z
  .object({
    skill,
    publication: z.literal('published'),
    developmentOnly: z.literal(false),
    requiredChecks: z
      .array(z.enum(['V1', 'V3', 'V6']))
      .min(2)
      .max(3)
      .refine(
        (checks) =>
          checks.includes('V1') && checks.includes('V3') && new Set(checks).size === checks.length,
      ),
    minimumEvidence: z.number().int().min(1).max(40),
    risk: reviewRiskSchema,
    cardType: z.literal('finalize'),
  })
  .strict();
export const reviewPolicySchema = z.discriminatedUnion('publication', [
  draftReviewPolicySchema,
  publishedReviewPolicySchema,
]);
export type ReviewPolicy = z.infer<typeof reviewPolicySchema>;
export const reviewEvidenceRefSchema = documentCitationSchema
  .extend({ readInvocationId: id })
  .strict();
export type ReviewEvidenceRef = z.infer<typeof reviewEvidenceRefSchema>;
const reviewDiffSectionSchema = z
  .object({
    baseVersionId: id.nullable(),
    changes: z
      .array(
        z
          .object({
            path: workspacePathSchema,
            change: z.enum(['added', 'modified', 'deleted']),
            beforeSha256: sha256Schema.nullable(),
            afterSha256: sha256Schema.nullable(),
          })
          .strict(),
      )
      .max(1000, '单次改动过多，请缩小交付范围后提交。'),
  })
  .strict();
export const reviewDiffSchema = reviewDiffSectionSchema.extend({
  approvalBase: reviewDiffSectionSchema.optional(),
});
export const reviewSubmitResultSchema = z
  .object({
    reviewId: id,
    version,
    status: z.literal('pending'),
    workspaceVersion: id,
    skill,
    requiresBrowserDecision: z.literal(true),
  })
  .strict();
export const reviewUndoStateSchema = z.object({ created: z.literal(false) }).strict();
export const reviewParamsSchema = z.object({ id }).strict();
export const reviewDecisionInputSchema = z
  .object({
    expectedVersion: version,
    workspaceVersion: id,
    requestKey: id,
    action: z.enum(['approved', 'rejected']),
    reason: statement.nullable().default(null),
  })
  .strict()
  .refine(
    (input) => input.action !== 'rejected' || input.reason !== null,
    '退回审核必须说明原因。',
  );
export type ReviewDecisionInput = z.infer<typeof reviewDecisionInputSchema>;
export const reviewJudgmentRecordSchema = z.object({ statement, createdAt: instant }).strict();
export const reviewSections = [
  'conclusion',
  'requestedAction',
  'decisions',
  'changes',
  'evidence',
  'checks',
  'uncertainties',
  'actions',
] as const;
export const reviewSectionsSchema = z.tuple([
  z.literal('conclusion'),
  z.literal('requestedAction'),
  z.literal('decisions'),
  z.literal('changes'),
  z.literal('evidence'),
  z.literal('checks'),
  z.literal('uncertainties'),
  z.literal('actions'),
]);

const common = {
  id,
  projectId: id,
  goalId: id,
  conversationId: id,
  workspaceVersion: id,
  skill,
  risk: reviewRiskSchema,
  cardType: z.literal('finalize'),
  status: reviewStatusSchema,
  version,
  createdAt: instant,
  decidedAt: instant.nullable(),
};
const legacyReviewSubmissionSchema = z
  .object({
    ...legacyStructuredSubmissionSchema.shape,
    decisions: z.tuple([]),
  })
  .strict()
  .superRefine((submission, context) => {
    // 派生展示字段不属于历史存储内容；旧结构的完整校验和64000字符上限仍照常执行。
    const { decisions: _decisions, ...stored } = submission;
    const parsed = legacyStructuredSubmissionSchema.safeParse(stored);
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        context.addIssue({ code: 'custom', message: issue.message, path: issue.path });
  });
const reviewCardBaseSchema = z
  .object({
    ...common,
    requiresJudgment: z.literal(false),
    sections: reviewSectionsSchema,
    checks: checkReportSchema,
    evaluation: evaluationStatusViewSchema.nullable().optional(),
    diff: reviewDiffSchema,
    evidenceRefs: z.array(reviewEvidenceRefSchema).max(40),
    judgment: reviewJudgmentRecordSchema.nullable(),
    decision: z
      .object({
        id,
        action: z.enum(['approved', 'rejected']),
        reason: statement.nullable(),
        actorUserId: id,
        createdAt: instant,
        snapshotId: id.nullable(),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
export const reviewCardViewSchema = z.discriminatedUnion('legacySubmission', [
  reviewCardBaseSchema.extend({
    legacySubmission: z.literal(false),
    submission: structuredSubmissionSchema,
  }),
  reviewCardBaseSchema.extend({
    legacySubmission: z.literal(true),
    submission: legacyReviewSubmissionSchema,
  }),
]);
export type ReviewCardView = z.infer<typeof reviewCardViewSchema>;
export const reviewDecisionResultSchema = z
  .object({
    cardId: id,
    status: z.enum(['approved', 'rejected']),
    version,
    decisionId: id,
    snapshotId: id.nullable(),
    replayed: z.boolean(),
  })
  .strict()
  .refine(
    (result) => (result.status === 'approved') === (result.snapshotId !== null),
    '审核决定与冻结回执不一致。',
  );
