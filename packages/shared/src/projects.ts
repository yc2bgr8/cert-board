import { z } from 'zod';
export const developmentProjectSeedConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test']),
});

export const projectIdSchema = z.string().uuid('项目编号无效，请从项目列表重新选择。');
export const projectParamsSchema = z.object({ id: projectIdSchema }).strict();
export const expectedVersionSchema = z.number().int().positive('版本号无效，请刷新后重试。');
export const projectTypeSchema = z.enum(['registration', 'maintenance']);
export const projectStatusSchema = z.enum([
  'preparing',
  'submitted',
  'under_review',
  'deficiency',
  'approved',
  'rejected',
  'closed',
  'cancelled',
]);
export const goalStatusSchema = z.enum([
  'active',
  'waiting_materials',
  'waiting_external',
  'waiting_decision',
  'pending_review',
  'human_controlled',
  'paused',
  'completed',
  'cancelled',
]);
const instantSchema = z.string().datetime({ offset: true });
const optionalId = z.string().uuid().nullable();
const nameSchema = z.string().trim().min(1).max(255);
const jurisdictionSchema = z
  .string()
  .max(80)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, '法域时区无效，请使用已确认的IANA时区。');

export const projectCreateSchema = z
  .object({
    name: nameSchema,
    projectType: projectTypeSchema,
    market: z.enum(['US', 'CA', 'US_CA']),
    pathway: z.string().trim().min(1).max(120),
    reviewerUserId: optionalId.default(null),
    modelId: optionalId.optional().default(null),
    applicantEntityId: optionalId.optional().default(null),
    holderEntityId: optionalId.optional().default(null),
    targetAt: instantSchema.nullable().optional().default(null),
    jurisdictionTz: jurisdictionSchema.default('America/New_York'),
    nextAction: z.string().trim().max(2000).nullable().optional().default(null),
  })
  .strict();
export type ProjectCreate = z.infer<typeof projectCreateSchema>;

export const projectPatchSchema = z
  .object({
    name: nameSchema.optional(),
    nextAction: z.string().trim().max(2000).nullable().optional(),
    targetAt: instantSchema.nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, '请至少提供一项改动。');
export type ProjectPatch = z.infer<typeof projectPatchSchema>;

export const projectRecordSchema = z
  .object({
    id: projectIdSchema,
    code: z.string().min(1).max(32),
    name: nameSchema,
    projectType: projectTypeSchema,
    market: z.enum(['US', 'CA', 'US_CA']),
    pathway: z.string().min(1).max(120),
    modelId: optionalId,
    ownerUserId: z.string().uuid(),
    reviewerUserId: optionalId,
    applicantEntityId: optionalId,
    holderEntityId: optionalId,
    targetAt: instantSchema.nullable(),
    jurisdictionTz: jurisdictionSchema,
    status: projectStatusSchema,
    submissionNumber: z.string().nullable(),
    submittedAt: instantSchema.nullable(),
    acceptedAt: instantSchema.nullable(),
    nextAction: z.string().nullable(),
    version: expectedVersionSchema,
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .strict();
export type ProjectRecord = z.infer<typeof projectRecordSchema>;

export const goalRecordSchema = z
  .object({
    id: z.string().uuid(),
    projectId: projectIdSchema,
    ownerUserId: z.string().uuid(),
    title: z.string().min(1).max(255),
    acceptanceCriteria: z.string().min(1),
    dueAt: instantSchema.nullable(),
    budgetUsd: z.number().finite().nonnegative(),
    status: goalStatusSchema,
    directionVersion: z.number().int().positive(),
    version: expectedVersionSchema,
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .strict();
export type GoalRecord = z.infer<typeof goalRecordSchema>;

export const projectListOptionsSchema = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(50),
  })
  .strict();
export const projectListSchema = z
  .object({
    items: z.array(projectRecordSchema).max(50),
    hasMore: z.boolean(),
    nextCursor: z.string().uuid().nullable(),
  })
  .strict();
export const goalListSchema = z
  .object({
    items: z.array(goalRecordSchema).max(50),
    hasMore: z.boolean(),
    nextCursor: z.string().uuid().nullable(),
  })
  .strict();
