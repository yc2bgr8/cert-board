import { z } from 'zod';

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
    dueAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .refine(
    ({ source, dueAt }) => source !== 'timer' || dueAt !== undefined,
    '定时等待需指定到期时间。',
  );
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
export const goalArrivalInputSchema = z.object({ sourceKey: reference }).strict();
