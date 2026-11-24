import { z } from 'zod';

export const m02ScheduleInputSchema = z.strictObject({
  enabled: z.boolean(),
  expectedVersion: z.number().int().min(0).max(2_147_483_647),
});
export type M02ScheduleInput = z.infer<typeof m02ScheduleInputSchema>;

export const m02ScheduleViewSchema = z.strictObject({
  enabled: z.boolean(),
  version: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
});
