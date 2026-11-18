import { z } from 'zod';
import { sha256Schema, documentDataLevelSchema } from './documents.js';
import { workspacePathSchema } from './workspace-path.js';
import {
  workspaceDataLevelSchema,
  workspaceFileRecordSchema,
  workspaceReadFileSchema,
  workspaceWriteFileSchema,
  workspaceSaveSchema,
  workspaceRestoreSchema,
  workspaceSaveResultSchema,
  workspaceWriteResultSchema,
  workspaceRebaseResultSchema,
} from './workspace.js';

const id = z.string().uuid();
const count = z.number().int().nonnegative().safe();
const positive = z.number().int().positive().safe();
const validText = (value: string) => /^[^\uD800-\uDFFF]*$/u.test(value) && !value.includes('\0');
const view = z.enum(['draft', 'current']).default('draft');
export const workspaceToolListInputSchema = z
  .object({
    view,
    cursor: workspacePathSchema.optional(),
    limit: z.number().int().min(1).max(20).default(20),
  })
  .strict();
export const workspaceToolReadInputSchema = z
  .object({
    view,
    path: workspacePathSchema,
    offset: count.default(0),
    limit: z.number().int().min(1).max(12000).default(8000),
  })
  .strict();
export const workspaceToolSearchCursorSchema = z
  .object({ stateToken: sha256Schema, path: workspacePathSchema, offset: count })
  .strict();
export const workspaceToolSearchInputSchema = z
  .object({
    view,
    query: z.string().min(1).max(200).refine(validText),
    cursor: workspaceToolSearchCursorSchema.optional(),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();
export const workspaceToolEditInputSchema = z
  .object({
    path: workspacePathSchema,
    expectedSha256: sha256Schema,
    oldText: z.string().min(1).max(64000).refine(validText),
    newText: z.string().max(64000).refine(validText),
  })
  .strict();
export const workspaceToolWriteInputSchema = workspaceWriteFileSchema.extend({
  expectedSha256: sha256Schema.nullable().default(null),
});
export const workspaceToolSaveInputSchema = workspaceSaveSchema
  .extend({ expectedDraftVersion: positive })
  .strict();
export const workspaceToolRestoreInputSchema = workspaceRestoreSchema
  .extend({ expectedDraftVersion: positive })
  .strict();
const location = {
  workspaceId: id,
  projectId: id,
  view: z.enum(['draft', 'current']),
  versionId: id,
  currentVersionId: id,
  draftId: id.nullable(),
  draftVersion: positive.nullable(),
  stateToken: sha256Schema,
  dataLevel: workspaceDataLevelSchema,
};
export const workspaceToolListSchema = z
  .object({
    ...location,
    items: z.array(workspaceFileRecordSchema).max(20),
    hasMore: z.boolean(),
    nextCursor: workspacePathSchema.nullable(),
  })
  .strict();
export const workspaceToolReadSchema = workspaceReadFileSchema.safeExtend(location).strict();
export const workspaceToolSearchSchema = z
  .object({
    ...location,
    items: z
      .array(
        z
          .object({
            path: workspacePathSchema,
            sha256: sha256Schema,
            matchOffset: count,
            snippet: z.string().max(300).refine(validText),
            dataLevel: workspaceDataLevelSchema,
          })
          .strict(),
      )
      .max(20),
    scannedFiles: count.max(20),
    skippedFiles: count.max(20),
    scannedBytes: count.max(4 * 1024 * 1024),
    warning: z.string().max(300).nullable(),
    truncated: z.boolean(),
    nextCursor: workspaceToolSearchCursorSchema.nullable(),
  })
  .strict()
  .refine((value) => value.truncated === (value.nextCursor !== null));
export const workspaceToolWriteSchema = workspaceWriteResultSchema
  .extend({ stateToken: sha256Schema })
  .strict();
export const workspaceToolSaveSchema = workspaceSaveResultSchema
  .extend({ workspaceVersion: id, stateToken: sha256Schema })
  .strict();
export const workspaceToolRebaseSchema = workspaceRebaseResultSchema
  .extend({ currentVersionId: id, stateToken: sha256Schema })
  .strict();
export const workspaceUndoOverlaySchema = z
  .object({
    path: workspacePathSchema,
    sha256: sha256Schema.nullable(),
    byteSize: count.nullable(),
    dataLevel: documentDataLevelSchema,
    mediaType: z.string().min(1).max(255),
    isDeleted: z.boolean(),
  })
  .strict()
  .refine((value) =>
    value.isDeleted
      ? value.sha256 === null && value.byteSize === null
      : value.sha256 !== null && value.byteSize !== null,
  );
export const workspaceUndoSnapshotSchema = z
  .object({
    workspaceId: id,
    projectId: id,
    conversationId: id,
    ownerUserId: id,
    draftId: id,
    publicVersionId: id,
    baseVersionId: id,
    overlay: z.array(workspaceUndoOverlaySchema).max(10000),
  })
  .strict();
export type WorkspaceUndoSnapshot = z.infer<typeof workspaceUndoSnapshotSchema>;
export const workspaceToolUndoStateSchema = z
  .object({
    snapshotSha256: sha256Schema,
    byteSize: count.max(25 * 1024 * 1024),
    publishes: z.boolean(),
  })
  .strict();
export type WorkspaceToolUndoState = z.infer<typeof workspaceToolUndoStateSchema>;
