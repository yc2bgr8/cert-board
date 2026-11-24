import { z } from 'zod';
import { workspaceDataLevelSchema, workspaceVersionRecordSchema } from './workspace.js';
import { workspacePathSchema } from './workspace-path.js';

export const humanRevisionMaxBytes = 128 * 1024;
const reviewId = z.uuid();
const revisionText = z
  .string()
  .min(1)
  .max(humanRevisionMaxBytes)
  .refine(
    (text) =>
      text.trim().length > 0 &&
      !text.includes('\0') &&
      /^[^\uD800-\uDFFF]*$/u.test(text) &&
      new TextEncoder().encode(text).length <= humanRevisionMaxBytes,
  );
const paragraph = z.strictObject({
  kind: z.enum(['added', 'removed']),
  number: z.number().int().positive(),
  text: z.string().max(2000),
  truncated: z.boolean(),
});
export const humanRevisionDifferenceSchema = z.strictObject({
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  paragraphs: paragraph.array().max(80),
  truncated: z.boolean(),
});
export const humanRevisionInputSchema = z.strictObject({
  reviewId,
  sourceVersionId: z.uuid(),
  expectedCurrentVersionId: z.uuid(),
  requestKey: z.uuid(),
  path: workspacePathSchema,
  text: revisionText,
  dataLevel: workspaceDataLevelSchema,
});
export const humanRevisionQuerySchema = z.strictObject({ reviewId, cursor: z.uuid().optional() });
export const humanRevisionViewSchema = z.strictObject({
  id: z.uuid(),
  reviewId,
  path: workspacePathSchema,
  sourceVersionId: z.uuid(),
  version: workspaceVersionRecordSchema,
  skillId: z.string().min(1).max(64),
  skillVersion: z.string().min(1).max(128),
  difference: humanRevisionDifferenceSchema,
});
export const humanRevisionListSchema = z.strictObject({
  items: humanRevisionViewSchema.array().max(5),
  nextCursor: z.uuid().nullable(),
});
export type HumanRevisionInput = z.infer<typeof humanRevisionInputSchema>;
export type HumanRevisionDifference = z.infer<typeof humanRevisionDifferenceSchema>;
