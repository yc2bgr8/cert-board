import { z } from 'zod';
import { workspacePathSchema } from './workspace-path.js';
import { documentDataLevelSchema, sha256Schema } from './documents.js';

export const workspaceFileDescriptorSchema = z.object({
  path: workspacePathSchema,
  sha256: sha256Schema,
  byteSize: z.number().int().nonnegative().safe(),
  dataLevel: documentDataLevelSchema,
  mediaType: z.string().min(1).max(255),
});
export type WorkspaceFileDescriptor = z.infer<typeof workspaceFileDescriptorSchema>;
export const workspaceFileChangeSchema = z
  .object({
    path: workspacePathSchema,
    change: z.enum(['added', 'modified', 'deleted']),
    before: workspaceFileDescriptorSchema.nullable(),
    after: workspaceFileDescriptorSchema.nullable(),
  })
  .strict();
export const workspaceFileDiffSchema = z
  .object({
    changes: z.array(workspaceFileChangeSchema).max(100),
    hasMore: z.boolean(),
    nextCursor: workspacePathSchema.nullable(),
  })
  .strict();
export const workspaceTextDiffOptionsSchema = z
  .object({
    offset: z.coerce.number().int().nonnegative().safe().default(0),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
export const workspaceTextDiffSchema = z
  .object({
    available: z.boolean(),
    lines: z
      .array(
        z
          .object({
            kind: z.enum(['context', 'added', 'removed']),
            oldLine: z.number().int().positive().nullable(),
            newLine: z.number().int().positive().nullable(),
            text: z.string().max(1000),
            ending: z.enum(['', '\n', '\r\n']),
            lineTruncated: z.boolean(),
          })
          .strict(),
      )
      .max(200),
    added: z.number().int().nonnegative().nullable(),
    removed: z.number().int().nonnegative().nullable(),
    totalLines: z.number().int().nonnegative().nullable(),
    offset: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    nextOffset: z.number().int().nonnegative().nullable(),
    warning: z.string().max(512).nullable(),
  })
  .strict();

export const workspaceDiffQuerySchema = z
  .object({
    from: z.string().uuid(),
    to: z.string().uuid(),
    path: workspacePathSchema.optional(),
    cursor: workspacePathSchema.optional(),
    offset: z.coerce.number().int().nonnegative().safe().default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export const workspaceFileQuerySchema = z
  .object({
    versionId: z.string().uuid().optional(),
    cursor: workspacePathSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export const workspaceReadQuerySchema = z
  .object({
    versionId: z.string().uuid().optional(),
    offset: z.coerce.number().int().nonnegative().safe().default(0),
    limit: z.coerce.number().int().min(1).max(12000).default(8000),
  })
  .strict();
export const workspaceFilePathParamsSchema = z
  .object({ id: z.string().uuid(), '*': workspacePathSchema })
  .strict();
export const workspaceDiffResponseSchema = z.discriminatedUnion('kind', [
  workspaceFileDiffSchema.extend({ kind: z.literal('files') }),
  z
    .object({
      kind: z.literal('text'),
      path: workspacePathSchema,
      beforeSha256: sha256Schema.nullable(),
      afterSha256: sha256Schema.nullable(),
      diff: workspaceTextDiffSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('binary'),
      path: workspacePathSchema,
      beforeSha256: sha256Schema.nullable(),
      afterSha256: sha256Schema.nullable(),
      warning: z.string().max(512),
    })
    .strict(),
]);
