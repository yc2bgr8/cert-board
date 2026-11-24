import { z } from 'zod';
import { documentCitationSchema } from './checks.js';

const code = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/u);
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((item) => /^[^\uD800-\uDFFF]*$/u.test(item) && !item.includes('\0'));
const subject = text(120);
const timestamp = z.iso.datetime({ offset: true }).refine((item) => {
  const offset = /[+-](\d{2}):(\d{2})$/u.exec(item);
  return !offset || Number(offset[1]) * 60 + Number(offset[2]) <= 14 * 60;
});
const evidence = documentCitationSchema.refine(({ quote }) => quote.length <= 1200);
const value = z.union([text(600), z.number().finite(), z.boolean()]);
const unit = text(32).nullable();
const dataLevel = z.enum(['internal', 'confidential']);
const hasUnit = (item: { value: string | number | boolean; unit: string | null }) =>
  typeof item.value !== 'number' || item.unit !== null;
const unitIssue = { path: ['unit'], message: '数值须带单位，无量纲时明确填写无量纲。' };

export const factProposalSchema = z
  .strictObject({
    subject,
    field: code,
    value,
    unit: unit.default(null),
    evidence,
    dueAt: timestamp.nullable().default(null),
  })
  .refine(hasUnit, unitIssue);
export type FactProposal = z.infer<typeof factProposalSchema>;

export const factProposalResultSchema = factProposalSchema.safeExtend({
  id: z.uuid(),
  projectId: z.uuid(),
  status: z.enum(['pending', 'confirmed', 'rewritten', 'rejected', 'cancelled']),
  baseRevision: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  createdAt: timestamp,
});
export type FactProposalResult = z.infer<typeof factProposalResultSchema>;
export const factCandidateSchema = factProposalResultSchema.safeExtend({ dataLevel });
export type FactCandidate = z.infer<typeof factCandidateSchema>;

const factOptions = {
  validUntil: timestamp.nullable().default(null),
  locked: z.boolean().optional(),
};
const expectedVersion = z.number().int().positive().max(2_147_483_647);
export const factDecisionInputSchema = z
  .discriminatedUnion('decision', [
    z.strictObject({
      decision: z.literal('set_due'),
      expectedVersion,
      dueAt: timestamp.nullable(),
    }),
    z.strictObject({ decision: z.literal('confirm'), expectedVersion, ...factOptions }),
    z.strictObject({
      decision: z.literal('rewrite'),
      expectedVersion,
      ...factOptions,
      value,
      unit: unit.default(null),
      evidence,
      reason: text(600),
    }),
    z.strictObject({
      decision: z.literal('reject'),
      expectedVersion,
      reason: text(600),
    }),
  ])
  .refine((item) => item.decision !== 'rewrite' || hasUnit(item), unitIssue);
export type FactDecisionInput = z.infer<typeof factDecisionInputSchema>;

export const confirmedFactSchema = z
  .strictObject({
    id: z.uuid(),
    subject,
    field: code,
    value,
    unit,
    evidence,
    revision: z.number().int().positive(),
    replacesId: z.uuid().nullable(),
    validFrom: timestamp,
    validUntil: timestamp.nullable(),
    locked: z.boolean(),
    confirmedBy: z.uuid(),
  })
  .refine(hasUnit, unitIssue);
export type ConfirmedFact = z.infer<typeof confirmedFactSchema>;

const https = z
  .url()
  .max(1600)
  .refine((address) => {
    try {
      const url = new URL(address);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      return false;
    }
  });
const ruleSource = z.strictObject({
  url: https,
  archiveUrl: https,
  section: text(160),
  checkedOn: z.iso.date(),
});
const marketRuleSchema = z.strictObject({
  id: code,
  statement: text(700),
  status: z.enum(['draft', 'pending_confirmation']),
  source: ruleSource,
  parameters: z.record(code, value).optional(),
});
export const rulePackSeedSchema = z.strictObject({
  code,
  title: text(160),
  jurisdiction: z.string().regex(/^[A-Z]{2}$/u),
  version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/u),
  rules: z
    .array(marketRuleSchema)
    .min(1)
    .max(12)
    .refine((rules) => new Set(rules.map(({ id }) => id)).size === rules.length),
});
export type RulePackSeed = z.infer<typeof rulePackSeedSchema>;

export const knowledgeGetInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('rule_pack'), code }),
  z.strictObject({
    kind: z.literal('facts'),
    subject: subject.optional(),
    field: code.optional(),
    afterId: z.uuid().optional(),
    limit: z.number().int().min(1).max(10).default(5),
  }),
]);
export type KnowledgeGetInput = z.infer<typeof knowledgeGetInputSchema>;
export const knowledgeGetResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('rule_pack'),
    pack: rulePackSeedSchema
      .extend({
        versionId: z.uuid(),
        publication: z.enum(['development', 'published']),
      })
      .nullable(),
  }),
  z.strictObject({
    kind: z.literal('facts'),
    facts: confirmedFactSchema.array().max(10),
    nextAfterId: z.uuid().nullable(),
  }),
]);
