import { z } from 'zod';
import { goalStatusSchema } from './projects.js';

const uid = z.string().uuid();
const reference = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/u);
const text = (limit: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(limit)
    .refine((value) => !value.includes('\0') && /^[^\uD800-\uDFFF]*$/u.test(value));

export const goalWaitInputSchema = z
  .object({
    source: z.enum(['document', 'timer', 'manual']),
    sourceKey: reference,
    reason: text(500),
    nextStep: text(500),
    dueAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .refine(
    ({ source, dueAt }) => source !== 'timer' || dueAt !== undefined,
    '定时等待需指定到期时间。',
  )
  .refine(({ source, sourceKey }) => {
    if (source !== 'document') return true;
    const [documentId, version, excess] = sourceKey.split(':');
    return (
      excess === undefined &&
      uid.safeParse(documentId).success &&
      /^[1-9][0-9]{0,9}$/u.test(version ?? '') &&
      Number(version) <= 2147483647
    );
  }, '资料来源编号必须是资料 UUID 加冒号和版本号，例如 c1a12d0e-f30e-4c43-91dc-1afcf321be01:2。');
export const goalWaitResultSchema = z
  .object({
    waitId: uid,
    goalId: uid,
    source: goalWaitInputSchema.shape.source,
    sourceKey: reference,
  })
  .strict();
export const goalControlInputSchema = z
  .object({
    action: z.enum(['takeover', 'handoff']),
    expectedVersion: z.number().int().positive(),
    note: text(4000),
  })
  .strict();
export type GoalControlInput = z.infer<typeof goalControlInputSchema>;
export const goalTakeoverStatuses = [
  'active',
  'waiting_external',
  'waiting_materials',
  'waiting_decision',
  'pending_review',
] as const satisfies readonly z.infer<typeof goalStatusSchema>[];

export const goalControlResultSchema = z.strictObject({
  goalId: uid,
  status: goalStatusSchema,
  version: z.number().int().positive(),
  directionVersion: z.number().int().positive(),
});
export type GoalControlResult = z.infer<typeof goalControlResultSchema>;
export const goalArrivalInputSchema = z.object({ sourceKey: reference }).strict();
