import { z } from 'zod';

const id = z.uuid();
const integer = z.number().int().nonnegative().safe();
const instant = z.string().datetime({ offset: true });
export const skillRollbackPolicyInputSchema = z
  .object({
    minimumCards: z.number().int().min(1).max(100),
    rejectionPercent: z.number().int().min(1).max(100),
    expectedRevision: integer,
  })
  .strict();
export const skillRollbackPolicySchema = skillRollbackPolicyInputSchema
  .omit({ expectedRevision: true })
  .extend({
    revision: integer,
  })
  .strict();

export const skillRollbackEvidenceSchema = z
  .object({
    total: integer,
    rejected: integer,
    from: instant,
    to: instant,
    previous: z.object({ total: integer, rejected: integer }).strict().nullable(),
    reasons: z.array(z.string().max(500)).max(3),
  })
  .strict();
export const skillRollbackProposalSchema = z
  .object({
    id,
    skillId: z.string().regex(/^[A-Z][0-9]{2}$/u),
    activeVersion: z.string().min(1).max(128),
    previousVersion: z.string().min(1).max(128).nullable(),
    status: z.enum(['pending', 'notice']),
    releaseRevision: integer,
    evidence: skillRollbackEvidenceSchema,
    createdAt: instant,
  })
  .strict();
export const skillRollbackListSchema = z
  .object({ items: z.array(skillRollbackProposalSchema).max(60) })
  .strict();
export const skillRollbackDecisionInputSchema = z
  .object({
    action: z.enum(['approve', 'dismiss']),
    expectedRevision: integer,
    requestKey: id,
  })
  .strict();
export const skillRollbackDecisionResultSchema = z
  .object({
    proposalId: id,
    status: z.enum(['approved', 'dismissed']),
    replayed: z.boolean(),
  })
  .strict();
export type SkillRollbackEvidence = z.infer<typeof skillRollbackEvidenceSchema>;
export type SkillRollbackProposal = z.infer<typeof skillRollbackProposalSchema>;
export type SkillRollbackPolicyInput = z.infer<typeof skillRollbackPolicyInputSchema>;
export type SkillRollbackPolicy = z.infer<typeof skillRollbackPolicySchema>;
export type SkillRollbackDecisionInput = z.infer<typeof skillRollbackDecisionInputSchema>;
