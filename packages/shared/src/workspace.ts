import { z } from 'zod';
import { documentDataLevelSchema, sha256Schema } from './documents.js';
import { workspacePathSchema } from './workspace-path.js';

const idSchema = z.string().uuid('工作区、对话或版本编号无效，请重新选择。');
const positiveInteger = z.number().int().positive().safe();
const nonnegativeInteger = z.number().int().nonnegative().safe();
const instantSchema = z.string().datetime({ offset: true });
export const workspaceDataLevelSchema = z.enum(['internal', 'confidential'], {
  error: '工作区和对话的资料级别最低为内部。',
});
export const permissionModeSchema = z.enum(['read_only', 'ask', 'full']);
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export const defaultPermissionMode: PermissionMode = 'full';
export const agentCodeSchema = z.enum(['registration', 'maintenance']);
export type AgentCode = z.infer<typeof agentCodeSchema>;
export const conversationStatusSchema = z.enum(['active', 'archived']);
export const workspaceAuthorTypeSchema = z.enum(['human', 'ai', 'system']);
const summarySchema = z.string().trim().min(1, '请简述本次工作区改动。').max(2000);
const textContentSchema = z
  .string()
  .refine(
    (text) => /^[^\uD800-\uDFFF]*$/u.test(text) && !text.includes('\0'),
    '文本包含无效字符，请提供完整的 UTF-8 文本。',
  )
  .refine((text) => [...text].length <= 1_000_000, '文本过长，请分成多个工作区文件。');
const returnedTextSchema = z
  .string()
  .refine(
    (text) => text.length <= 12000,
    '每次最多返回 12000 个 UTF-16 码元，请按 nextOffset 继续读取。',
  )
  .refine(
    (text) => /^[^\uD800-\uDFFF]*$/u.test(text),
    '读取文本在完整字符边界截断，请检查继续读取的位置。',
  );

export const conversationCreateSchema = z
  .object({
    projectId: idSchema.nullable(),
    goalId: idSchema.nullable().default(null),
    title: z.string().trim().min(1).max(255),
    permissionMode: permissionModeSchema.default(defaultPermissionMode),
    agentCode: agentCodeSchema.default('registration'),
  })
  .strict()
  .refine(
    (value) => value.goalId === null || value.projectId !== null,
    '关联目标的对话必须属于该目标的项目。',
  );
export const conversationRecordSchema = z
  .object({
    id: idSchema,
    projectId: idSchema.nullable(),
    userId: idSchema,
    goalId: idSchema.nullable(),
    title: z.string().min(1).max(255),
    permissionMode: permissionModeSchema,
    agentCode: agentCodeSchema,
    maxDataLevel: workspaceDataLevelSchema,
    status: conversationStatusSchema,
    version: positiveInteger,
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .strict();
export type ConversationRecord = z.infer<typeof conversationRecordSchema>;

export const workspaceRecordSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    // 空指针只允许存在于初始化事务内，不能作为已可用工作区返回。
    currentVersionId: idSchema,
    dataLevel: workspaceDataLevelSchema,
    version: positiveInteger,
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .strict();
export type WorkspaceRecord = z.infer<typeof workspaceRecordSchema>;

export const workspaceVersionRecordSchema = z
  .object({
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    number: positiveInteger,
    parentVersionId: idSchema.nullable(),
    authorUserId: idSchema.nullable(),
    authorType: workspaceAuthorTypeSchema,
    summary: summarySchema,
    dataLevel: workspaceDataLevelSchema,
    createdAt: instantSchema,
  })
  .strict()
  .refine(
    (value) => value.authorType === 'system' || value.authorUserId !== null,
    '人或 AI 产生的版本必须记录对应用户。',
  );
export type WorkspaceVersionRecord = z.infer<typeof workspaceVersionRecordSchema>;

export const workspaceDraftRecordSchema = z
  .object({
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    conversationId: idSchema,
    ownerUserId: idSchema,
    baseVersionId: idSchema,
    dataLevel: workspaceDataLevelSchema,
    version: positiveInteger,
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .strict();
export type WorkspaceDraftRecord = z.infer<typeof workspaceDraftRecordSchema>;

export const workspaceFileRecordSchema = z
  .object({
    path: workspacePathSchema,
    sha256: sha256Schema,
    byteSize: nonnegativeInteger,
    dataLevel: documentDataLevelSchema,
    mediaType: z.string().min(1).max(255),
  })
  .strict();
export type WorkspaceFileRecord = z.infer<typeof workspaceFileRecordSchema>;

export const workspaceWriteFileSchema = z
  .object({
    path: workspacePathSchema,
    content: textContentSchema,
    expectedSha256: sha256Schema.nullable(),
  })
  .strict();
export type WorkspaceWriteFile = z.infer<typeof workspaceWriteFileSchema>;
export const workspaceDeleteFileSchema = z
  .object({
    path: workspacePathSchema,
    expectedSha256: sha256Schema,
  })
  .strict();
export const workspaceSaveSchema = z.object({ summary: summarySchema }).strict();
export const workspaceRestoreSchema = z
  .object({ targetVersionId: idSchema, summary: summarySchema })
  .strict();
export const workspaceRebaseSchema = z
  .object({
    expectedDraftVersion: positiveInteger,
    expectedCurrentVersionId: idSchema,
    resolutions: z
      .array(
        z
          .object({
            path: workspacePathSchema,
            expectedCurrentSha256: sha256Schema.nullable(),
            expectedDraftSha256: sha256Schema.nullable(),
          })
          .strict(),
      )
      .max(100, '一次最多确认100项路径冲突，请缩小修改范围。')
      .default([]),
  })
  .strict()
  .superRefine((input, context) => {
    const seen = new Set<string>();
    for (const [index, resolution] of input.resolutions.entries()) {
      if (seen.has(resolution.path))
        context.addIssue({
          code: 'custom',
          path: ['resolutions', index, 'path'],
          message: '同一路径只能确认一次，请去除重复项。',
        });
      seen.add(resolution.path);
    }
  });
export type WorkspaceRebase = z.infer<typeof workspaceRebaseSchema>;
export const workspaceRebaseResultSchema = z.object({ draft: workspaceDraftRecordSchema }).strict();
export type WorkspaceRebaseResult = z.infer<typeof workspaceRebaseResultSchema>;

export const workspaceReadOptionsSchema = z
  .object({
    offset: z.coerce.number().int().nonnegative().safe().default(0),
    limit: z.coerce.number().int().min(1).max(12000).default(8000),
  })
  .strict();
export const workspaceReadFileSchema = workspaceFileRecordSchema
  .extend({
    workspaceId: idSchema,
    versionId: idSchema,
    draftId: idSchema.nullable(),
    text: returnedTextSchema,
    offset: nonnegativeInteger,
    totalCharacters: nonnegativeInteger,
    truncated: z.boolean(),
    nextOffset: nonnegativeInteger.nullable(),
  })
  .refine(
    (value) =>
      value.truncated
        ? value.nextOffset !== null &&
          value.nextOffset > value.offset &&
          value.nextOffset < value.totalCharacters
        : value.nextOffset === null,
    '工作区文本分页位置无效，请重新读取。',
  );
export type WorkspaceReadFile = z.infer<typeof workspaceReadFileSchema>;

export const workspaceVersionListOptionsSchema = z
  .object({
    afterNumber: z.coerce.number().int().nonnegative().safe().default(0),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    view: z.literal('recent').optional(),
  })
  .strict()
  .refine((value) => value.view !== 'recent' || value.afterNumber === 0, '最近版本无需分页位置。');
export const workspaceVersionListSchema = z
  .object({
    items: z.array(workspaceVersionRecordSchema).max(50),
    hasMore: z.boolean(),
    nextAfterNumber: positiveInteger.nullable(),
  })
  .strict()
  .refine(
    (value) => value.hasMore === (value.nextAfterNumber !== null),
    '工作区版本分页状态不一致。',
  );
export const workspaceFileListOptionsSchema = z
  .object({
    cursor: workspacePathSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export const workspaceFileListSchema = z
  .object({
    items: z.array(workspaceFileRecordSchema).max(100),
    hasMore: z.boolean(),
    nextCursor: workspacePathSchema.nullable(),
  })
  .strict()
  .refine((value) => value.hasMore === (value.nextCursor !== null), '工作区文件分页状态不一致。');

export const workspaceWriteResultSchema = z
  .object({ draft: workspaceDraftRecordSchema, file: workspaceFileRecordSchema })
  .strict();
export const workspaceSaveResultSchema = z
  .object({ version: workspaceVersionRecordSchema, draft: workspaceDraftRecordSchema })
  .strict();

export const workspaceParamsSchema = z.object({ id: idSchema }).strict();
export const workspaceVersionParamsSchema = z
  .object({ id: idSchema, versionId: idSchema })
  .strict();
export const workspaceDraftParamsSchema = z.object({ id: idSchema }).strict();
