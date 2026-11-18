import { z } from 'zod';
import { agentCodeSchema } from './workspace.js';
import { reviewPolicySchema } from './reviews.js';

const skillId = z.string().regex(/^[A-Z][0-9]{2}$/);
const version = z
  .string()
  .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/)
  .max(128);
export const agentSkillIndexSchema = z
  .object({
    id: skillId,
    version,
    name: z.string().min(1).max(120),
    summary: z.string().min(1).max(500),
  })
  .strict();
export const agentDefinitionMetadataSchema = z
  .object({
    code: agentCodeSchema,
    name: z.string().min(1).max(120),
    version,
    publication: z.literal('draft'),
    developmentOnly: z.literal(true),
    skills: z.array(agentSkillIndexSchema).min(1).max(12),
  })
  .strict()
  .refine(
    (value) => new Set(value.skills.map((skill) => skill.id)).size === value.skills.length,
    '技能索引不能包含重复编号。',
  );
export const agentDefinitionSchema = agentDefinitionMetadataSchema.safeExtend({
  systemPrompt: z.string().min(1).max(30000),
});
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export const skillLoadInputSchema = z.object({ id: skillId, version: version.optional() }).strict();
export const skillLoadResultSchema = z
  .object({
    skill: agentSkillIndexSchema.extend({ agentCode: agentCodeSchema }).strict(),
    body: z.string().min(1).max(24000),
    attachments: z.tuple([]),
    publication: z.literal('draft'),
    developmentOnly: z.literal(true),
    reviewPolicy: reviewPolicySchema,
  })
  .strict()
  .refine(
    (value) => JSON.stringify(value).length <= 30000,
    '技能正文过长，不能完整加载，请联系维护人员。',
  );
export type LoadedAgentSkill = z.infer<typeof skillLoadResultSchema>;
