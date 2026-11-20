import { z } from 'zod';
import { agentSkillIndexSchema } from './agent-definitions.js';
import { agentCodeSchema } from './workspace.js';
import { sha256Schema } from './documents.js';

export const skillVersionMetadataSchema = agentSkillIndexSchema
  .extend({
    agentCode: agentCodeSchema,
    capability: z.string().trim().min(1).max(120),
    level: z.union([z.literal(1), z.literal(2)]),
    modes: z
      .array(z.enum(['read_only', 'ask', 'full']))
      .min(1)
      .max(3),
    requiredChecks: z
      .array(z.enum(['V1', 'V3', 'V6']))
      .min(2)
      .max(3),
    minimumEvidence: z.number().int().min(1).max(40),
    risk: z.enum(['standard', 'high']),
    suggestedSubagents: z.array(z.string().trim().min(1).max(160)).max(8).default([]),
    evaluation: z.string().trim().min(1).max(160).optional(),
    budget: z
      .object({
        steps: z.number().int().min(1).max(60),
        tokens: z.number().int().min(1).max(400_000),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.modes).size !== value.modes.length)
      ctx.addIssue({ code: 'custom', path: ['modes'], message: '权限模式不能重复。' });
    if (
      new Set(value.requiredChecks).size !== value.requiredChecks.length ||
      !value.requiredChecks.includes('V1') ||
      !value.requiredChecks.includes('V3')
    )
      ctx.addIssue({
        code: 'custom',
        path: ['requiredChecks'],
        message: '必须保留原文及结构检查，检查项不能重复。',
      });
  });
export type SkillVersionMetadata = z.infer<typeof skillVersionMetadataSchema>;

const skillId = z.string().regex(/^[A-Z][0-9]{2}$/);
const uuid = z.string().uuid();
export const skillParamsSchema = z.object({ id: skillId }).strict();
export const skillActionSchema = z
  .object({
    action: z.enum(['publish', 'disable', 'rollback']),
    requestKey: uuid,
    expectedRevision: z.number().int().nonnegative(),
    versionId: uuid,
    contentSha256: sha256Schema,
  })
  .strict();
export type SkillActionInput = z.infer<typeof skillActionSchema>;
export const skillVersionViewSchema = z
  .object({
    id: uuid,
    metadata: skillVersionMetadataSchema,
    body: z.string().min(1).max(24000),
    contentSha256: sha256Schema,
    published: z.boolean(),
  })
  .strict();
export const skillVersionDraftSchema = skillVersionViewSchema.pick({ metadata: true, body: true });
export const skillViewSchema = z
  .object({
    id: skillId,
    agentCode: agentCodeSchema,
    revision: z.number().int().nonnegative(),
    activeVersionId: uuid.nullable(),
    previousVersionId: uuid.nullable(),
    versions: z.array(skillVersionViewSchema.omit({ body: true })).max(60),
  })
  .strict();
export const skillPageSchema = z.object({ items: z.array(skillViewSchema).max(60) }).strict();
export const skillActionResultSchema = z
  .object({
    skillId,
    revision: z.number().int().positive(),
    activeVersionId: uuid.nullable(),
    replayed: z.boolean(),
  })
  .strict();
