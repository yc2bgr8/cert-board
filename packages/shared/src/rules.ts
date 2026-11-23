import { z } from 'zod';
import { sha256Schema } from './documents.js';

export const consistencyRuleIds = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'] as const;
export const consistencyRuleIdSchema = z.enum(consistencyRuleIds);
export type RuleId = z.infer<typeof consistencyRuleIdSchema>;

const versionReference = z.strictObject({
  documentId: z.uuid(),
  version: z.number().int().positive().max(2_147_483_647),
});
const uniqueRefs = z
  .array(versionReference)
  .min(1)
  .max(64)
  .refine(
    (items) =>
      new Set(items.map(({ documentId, version }) => `${documentId}:${version}`)).size ===
      items.length,
    '同一资料版本只填写一次。',
  );
const uniqueRules = z
  .array(consistencyRuleIdSchema)
  .min(1)
  .max(8)
  .refine((ids) => new Set(ids).size === ids.length, '同一规则编号只填写一次。');
export const rulesRunInputSchema = z.strictObject({
  documents: uniqueRefs.optional(),
  rules: uniqueRules.default([...consistencyRuleIds]),
  offset: z.number().int().min(0).max(5000).default(0),
  limit: z.number().int().min(1).max(10).default(6),
});

const versionEvidence = versionReference.extend({
  contentSha256: sha256Schema,
  sourceKey: z.string().min(1).max(128),
});
const citation = versionEvidence.extend({
  page: z.number().int().positive().max(2_147_483_647),
  locatorKind: z.enum(['document_page', 'xfa_datasets']),
});
const finding = z.strictObject({
  findingKey: sha256Schema,
  ruleId: consistencyRuleIdSchema,
  version: z.string().min(1).max(24),
  title: z.string().min(1).max(320),
  status: z.enum(['candidate', 'notice', 'human_review']),
  values: z
    .array(
      z.strictObject({
        value: z.string().min(1).max(255),
        count: z.number().int().nonnegative().safe().optional(),
      }),
    )
    .max(16),
  references: z.array(citation).min(1).max(16),
  detailsTruncated: z.boolean(),
});
export const rulesRunResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    scanned: z.array(versionEvidence).min(1).max(64),
    pageCount: z.number().int().nonnegative().safe(),
    findings: z.array(finding).max(10),
    total: z.number().int().nonnegative().safe(),
    nextOffset: z.number().int().positive().max(5000).nullable(),
    notices: z.array(z.string().max(320)).max(16),
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    code: z.string().regex(/^RULES_[A-Z_]{1,40}$/u),
    message: z.string().max(400),
  }),
]);
