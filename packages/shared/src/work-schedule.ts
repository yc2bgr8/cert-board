import { z } from 'zod';

const nodeId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/u);
const shortText = z.string().trim().min(1).max(100);
const node = z.strictObject({
  id: nodeId,
  name: shortText,
  owner: shortText,
  durationDays: z.number().int().min(0).max(365),
  dependsOn: nodeId.array().max(29),
});

export const workScheduleInputSchema = z.strictObject({
  targetDate: z.iso.date(),
  earliestStartDate: z.iso.date().optional(),
  nodes: node.array().min(1).max(30),
});

export const workScheduleOutputSchema = z.strictObject({
  targetDate: z.iso.date(),
  latestStartDate: z.iso.date(),
  earliestFinishDate: z.iso.date().nullable(),
  criticalPath: nodeId.array().min(1).max(30),
  criticalDays: z.number().int().nonnegative(),
  feasibility: z.enum(['start_unconfirmed', 'feasible', 'start_too_late']),
  nodes: node
    .extend({ plannedStart: z.iso.date(), plannedFinish: z.iso.date() })
    .array()
    .min(1)
    .max(30),
});
