import { z } from 'zod';

export const deadlineDateSchema = z.iso.date().refine((value) => {
  const year = Number(value.slice(0, 4));
  return year >= 1900 && year <= 9998;
}, '日期年份须在 1900 至 9998 之间。');

export const deadlineCalculationSchema = z
  .object({
    startDate: deadlineDateSchema,
    quantity: z.number().int().min(-7305).max(7305),
    unit: z.enum(['calendar_days', 'calendar_months']),
    jurisdictionTz: z.string().min(1).max(100),
  })
  .strict()
  .superRefine(({ quantity, unit }, ctx) => {
    if (unit === 'calendar_months' && Math.abs(quantity) > 240)
      ctx.addIssue({ code: 'custom', path: ['quantity'], message: '按月最多加减 240 个月。' });
  });

export const deadlineCalculationResultSchema = z
  .object({
    calculation: deadlineCalculationSchema,
    dueDate: deadlineDateSchema,
    dueAt: z.iso.datetime({ offset: true }),
    beijingTime: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u),
  })
  .strict();

export const deadlineCheckSchema = z
  .object({
    calculation: deadlineCalculationSchema,
    statedDueAt: z.iso.datetime({ offset: true, precision: 3 }),
  })
  .strict();

export type DeadlineCalculation = z.infer<typeof deadlineCalculationSchema>;
export type DeadlineCalculationResult = z.infer<typeof deadlineCalculationResultSchema>;

export const reminderProfileSchema = z.enum(['certificate', 'milestone']);
export const deadlineStageSchema = z.enum(['D-90', 'D-60', 'D-30', 'D-7', 'D-1', 'D-0', 'OVERDUE']);
export const reminderInputSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^\r\n]+$/u),
    profile: reminderProfileSchema,
    calculation: deadlineCalculationSchema,
  })
  .strict();

export const reminderResultSchema = reminderInputSchema
  .extend({
    id: z.uuid(),
    goalId: z.uuid(),
    ownerId: z.uuid(),
    dueDate: deadlineDateSchema,
    dueAt: z.iso.datetime({ offset: true }),
    version: z.number().int().positive(),
  })
  .strict();

export const reminderUndoSchema = z
  .object({
    previous: z
      .object({
        plan: reminderResultSchema,
        state: z.enum(['active', 'cancelled']),
        conversationId: z.uuid(),
        lastStage: deadlineStageSchema.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const deadlineNoticeSchema = z
  .object({
    title: reminderInputSchema.shape.title,
    stage: deadlineStageSchema,
    dueDate: deadlineDateSchema,
    dueAt: z.iso.datetime({ offset: true }),
    beijingTime: deadlineCalculationResultSchema.shape.beijingTime,
    remainingDays: z.number().int(),
  })
  .strict();
export type DeadlineStage = z.infer<typeof deadlineStageSchema>;
export type ReminderProfile = z.infer<typeof reminderProfileSchema>;
export type ReminderUndo = z.infer<typeof reminderUndoSchema>;
export type DeadlineNotice = z.infer<typeof deadlineNoticeSchema>;
export const deadlineNoticeAckSchema = z
  .object({ seenAt: z.iso.datetime({ offset: true }) })
  .strict();
