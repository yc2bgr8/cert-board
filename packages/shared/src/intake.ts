import { z } from 'zod';
import { documentDataLevelSchema, documentParseStateSchema, sha256Schema } from './documents.js';
import { projectIdSchema } from './projects.js';

export const maximumIntakeBytes = 192 * 1024 * 1024;
export const maximumIntakeItems = 500;

export const intakeCategories = [
  'application',
  'device_description',
  'indications',
  'predicate',
  'labeling',
  'shelf_life',
  'biocompatibility',
  'software_security',
  'electrical',
  'performance',
  'human_factors',
  'summary',
  'declarations',
  'review_needed',
] as const;
export const intakeCategorySchema = z.enum(intakeCategories);
export type IntakeCategory = z.infer<typeof intakeCategorySchema>;
export const intakeStatusSchema = z.enum(['queued', 'running', 'parsing', 'complete', 'failed']);
export const intakeCategoryEditSchema = z
  .object({
    path: z.string().min(1).max(1024),
    category: intakeCategorySchema,
  })
  .strict();

const intakeName = z
  .string()
  .trim()
  .transform((value) => value.normalize('NFC'))
  .pipe(
    z
      .string()
      .min(1)
      .max(255)
      .refine((value) => !value.includes('/') && !value.includes('\\') && !/\p{Cc}/u.test(value)),
  );
export const intakeHistorySchema = z
  .object({
    items: z.array(z.object({ id: z.string().uuid(), name: intakeName }).strict()).max(50),
  })
  .strict();
const nonnegative = z.number().int().nonnegative().safe();
const nullableCode = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{1,63}$/u)
  .nullable();

export const intakeStartSchema = z
  .object({
    projectId: projectIdSchema,
    name: intakeName,
    dataLevel: documentDataLevelSchema.default('internal'),
  })
  .strict();

export const intakeStartResultSchema = z
  .object({
    id: z.string().uuid(),
    status: intakeStatusSchema,
    created: z.boolean(),
  })
  .strict();

const intakeItemSchema = z
  .object({
    path: z.string().min(1).max(1024),
    sha256: sha256Schema,
    byteSize: nonnegative,
    embedded: z.boolean(),
    parentPath: z.string().min(1).max(1024).nullable(),
    sourceNames: z.array(z.string().max(200)).max(128),
    duplicate: z.boolean(),
    category: intakeCategorySchema,
    confidence: z.number().min(0).max(1).nullable(),
    documentId: z.string().uuid().nullable(),
    version: z.number().int().positive().nullable(),
    parseStatus: documentParseStateSchema.nullable(),
    errorCode: nullableCode,
  })
  .strict();

export const intakeReportSchema = z
  .object({
    id: z.string().uuid(),
    projectId: projectIdSchema,
    name: intakeName,
    status: intakeStatusSchema,
    dataLevel: documentDataLevelSchema,
    errorCode: nullableCode,
    canRetry: z.boolean(),
    totals: z
      .object({
        outerFiles: nonnegative,
        embeddedFiles: nonnegative,
        uniqueFiles: nonnegative,
        duplicates: nonnegative,
        queued: nonnegative,
        ready: nonnegative,
        failed: nonnegative,
        reviewNeeded: nonnegative,
      })
      .strict(),
    categories: z.array(z.object({ category: intakeCategorySchema, count: nonnegative }).strict()),
    items: z.array(intakeItemSchema).max(maximumIntakeItems),
  })
  .strict();

export type IntakeReport = z.infer<typeof intakeReportSchema>;
