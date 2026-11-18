import { z } from 'zod';

export const runStopParamsSchema = z.object({ id: z.string().uuid() }).strict();
export const runStopInputSchema = z.object({}).strict();
export const runControlNotificationSchema = z
  .object({
    version: z.literal(1),
    action: z.literal('stop'),
    runId: z.string().uuid(),
    userId: z.string().uuid(),
  })
  .strict();
export const runStopResultSchema = z
  .object({
    runId: z.string().uuid(),
    status: z.enum([
      'queued',
      'running',
      'waiting',
      'completed',
      'failed',
      'stopped',
      'budget_exhausted',
    ]),
    changed: z.boolean(),
  })
  .strict();
export type RunStopResult = z.infer<typeof runStopResultSchema>;
