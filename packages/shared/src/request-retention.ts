import { z } from 'zod';

export const requestRetentionPolicySchema = z
  .object({
    environment: z.enum(['development', 'test', 'production']),
    retentionDays: z.number().int().min(0).max(30).default(0),
  })
  .strict();

export const syntheticModelRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    runId: z.string().uuid(),
    userId: z.string().uuid(),
    synthetic: z.literal(true),
    content: z
      .object({
        messages: z
          .array(
            z
              .object({
                role: z.enum(['system', 'user', 'assistant', 'tool']),
                content: z.string().max(32_000),
              })
              .strict(),
          )
          .min(1)
          .max(30),
      })
      .strict(),
  })
  .strict()
  .refine((value) => JSON.stringify(value.content).length <= 128_000, '合成请求内容过长。');

export const requestPurgeOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(1000).default(100),
  })
  .strict();
