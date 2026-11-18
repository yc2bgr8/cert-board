import { z } from 'zod';
import { checkReportSchema, documentCitationSchema, structuredSubmissionSchema } from './checks.js';
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
export const reviewPolicySchema = z
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
export type ReviewPolicy = z.infer<typeof reviewPolicySchema>;
export const reviewEvidenceRefSchema = documentCitationSchema
  .extend({ readInvocationId: id })
  .strict();
export type ReviewEvidenceRef = z.infer<typeof reviewEvidenceRefSchema>;
export const reviewDiffSchema = z
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
export const reviewJudgmentInputSchema = z
  .object({ expectedVersion: version, requestKey: id, statement })
  .strict();
export type ReviewJudgmentInput = z.infer<typeof reviewJudgmentInputSchema>;

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
const locked = z
  .object({ ...common, risk: z.literal('high'), requiresJudgment: z.literal(true) })
  .strict();
const visible = z
  .object({
    ...common,
    requiresJudgment: z.literal(false),
    submission: structuredSubmissionSchema,
    checks: checkReportSchema,
    diff: reviewDiffSchema,
    evidenceRefs: z.array(reviewEvidenceRefSchema).max(40),
    judgment: z.object({ statement, createdAt: instant }).strict().nullable(),
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
  .strict()
  .refine(
    (card) => card.risk !== 'high' || card.judgment !== null,
    '高风险卡必须有本人的独立判断才能显示AI内容。',
  );
export const reviewCardViewSchema = z.discriminatedUnion('requiresJudgment', [locked, visible]);
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
export const reviewJudgmentResultSchema = z
  .object({ cardId: id, judgmentId: id, recorded: z.literal(true), replayed: z.boolean() })
  .strict();
