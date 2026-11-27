import { z } from 'zod';
import { agentCodeSchema, permissionModeSchema } from './workspace.js';

export const taskCodeSchema = z.string().regex(/^(R(0[1-9]|1[0-2])|M(0[1-9]|1[0-2])|S0[1-5])$/u);
const version = z
  .string()
  .max(128)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
export const taskSelectionSchema = z
  .object({
    code: taskCodeSchema,
    skillVersion: version,
    scope: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .regex(/^[^\uD800-\uDFFF\0]*$/u)
      .optional(),
  })
  .strict();

export const taskAssignmentSchema = z
  .object({
    code: taskCodeSchema,
    skillVersion: version,
    runId: z.string().uuid(),
  })
  .strict();

export const taskCatalogSchema = z
  .object({
    projectType: agentCodeSchema,
    entries: z.array(
      z
        .object({
          code: taskCodeSchema,
          title: z.string(),
          description: z.string(),
          deliverable: z.string(),
          availability: z.enum(['ready', 'draft', 'pending', 'other_project', 'system']),
          skillVersion: version.nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const taskCatalogQuerySchema = z.object({ mode: permissionModeSchema }).strict();

export type TaskSelection = z.infer<typeof taskSelectionSchema>;
export type TaskAssignment = z.infer<typeof taskAssignmentSchema>;
export type TaskCatalogEntry = z.infer<typeof taskCatalogSchema>['entries'][number];
