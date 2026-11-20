import { z } from 'zod';
import { sha256Schema } from './documents.js';
import { docReadToolInputSchema } from './document-tools.js';
import { workspacePathSchema } from './workspace-path.js';

const nameSchema = z
  .string()
  .min(1)
  .max(160)
  .transform((value) => value.normalize('NFC'))
  .refine(
    (value) =>
      value.trim() === value &&
      !value.endsWith('.') &&
      !value.startsWith('.') &&
      !value.includes('/') &&
      !value.includes('\\') &&
      !value.includes(':') &&
      !/\p{Cc}/u.test(value),
  );
const inputSource = z.discriminatedUnion('source', [
  z
    .object({
      source: z.literal('workspace'),
      name: nameSchema,
      path: workspacePathSchema,
      view: z.enum(['draft', 'current']).default('draft'),
    })
    .strict(),
  z
    .object({
      source: z.literal('document'),
      name: nameSchema,
      documentId: docReadToolInputSchema.shape.id,
      version: docReadToolInputSchema.shape.version,
    })
    .strict(),
]);
const timeout = z.number().int().min(1).max(120);
const commonRun = {
  code: z.string().min(1).max(24_000),
  timeoutSeconds: timeout.default(30),
  inputs: z.array(inputSource).max(16).default([]),
};
export const codeRunInputSchema = z.object(commonRun).strict();
export const codeRunSaveInputSchema = z
  .object({
    ...commonRun,
    outputDirectory: workspacePathSchema,
    expectedDraftVersion: z.number().int().positive(),
  })
  .strict();
export const sandboxResultSchema = z
  .object({
    status: z.enum(['ok', 'timed_out', 'memory_limit', 'failed']),
    exitCode: z.number().int(),
    elapsedMs: z.number().int().nonnegative(),
    codeSha256: sha256Schema,
    inputHashes: z.array(z.object({ name: nameSchema, sha256: sha256Schema }).strict()).max(16),
    stdout: z.string().max(16_384),
    stderr: z.string().max(16_384),
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean(),
    files: z
      .array(
        z
          .object({
            path: workspacePathSchema,
            byteSize: z
              .number()
              .int()
              .min(0)
              .max(12 * 1024 * 1024),
            sha256: sha256Schema,
            bodyBase64: z.string().max(16 * 1024 * 1024),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
export const codeRunOutputSchema = sandboxResultSchema
  .omit({ files: true })
  .extend({
    documents: z
      .array(
        z
          .object({
            id: docReadToolInputSchema.shape.id,
            version: docReadToolInputSchema.shape.version,
          })
          .strict(),
      )
      .max(16),
    readsWorkspace: z.boolean(),
    outputCount: z.number().int().min(0).max(32),
    outputHashes: z.array(sha256Schema).max(32),
    files: z
      .array(
        z
          .object({
            path: workspacePathSchema,
            byteSize: z.number().int().nonnegative(),
            sha256: sha256Schema,
            workspacePath: workspacePathSchema.nullable(),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();
