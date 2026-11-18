import { z } from 'zod';

const text = (limit: number) =>
  z
    .string()
    .min(1)
    .max(limit)
    .refine((value) => value.trim().length > 0 && !value.includes('\0'));

export const agentPlanSchema = z
  .object({
    steps: z
      .array(
        z
          .object({ title: text(160), status: z.enum(['pending', 'running', 'completed']) })
          .strict(),
      )
      .min(1)
      .max(12),
    progress: text(400),
  })
  .strict()
  .refine(
    (value) => value.steps.filter((step) => step.status === 'running').length <= 1,
    '同一份计划最多有一个正在执行的步骤。',
  );

export const agentQuestionSchema = z
  .object({
    question: text(1200),
    options: z.array(text(160)).max(6).default([]),
  })
  .strict();
