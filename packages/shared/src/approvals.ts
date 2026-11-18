import { z } from 'zod';
import { documentDataLevelSchema, sha256Schema } from './documents.js';
import { toolNameSchema, toolVersionTokenSchema } from './tools.js';

const id = z.string().uuid();
const instant = z.string().datetime({ offset: true });
const bounded = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length <= 65536;
const text = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine(
      (value) => /^[^\uD800-\uDFFF]*$/u.test(value) && !value.includes('\0'),
      '文字必须为有效字符，不能包含空字符。',
    );
export const toolApprovalStatusSchema = z.enum(['pending', 'approved', 'rejected', 'cancelled']);
export const toolApprovalActionSchema = z.enum(['allow_once', 'allow_conversation', 'reject']);
export const toolApprovalDisplaySchema = z
  .object({
    summary: text(500),
    changes: z
      .array(
        z
          .object({
            recordType: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
            recordId: id,
            field: text(120),
            before: z.json(),
            after: z.json(),
          })
          .strict(),
      )
      .max(20),
    message: z
      .object({
        contactId: id,
        recipientName: text(120),
        subject: text(200).refine((value) => !/[\r\n]/.test(value), '主题不能换行。'),
        body: text(8000),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(bounded, '批准预览不能超过64 KiB。')
  .refine(
    (value) => value.changes.length > 0 || value.message !== undefined,
    '批准预览必须说明具体改动或消息内容。',
  );
export const toolApprovalTargetVersionsSchema = z
  .array(
    z
      .object({
        targetType: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
        targetId: id,
        version: toolVersionTokenSchema.nullable(),
      })
      .strict(),
  )
  .max(30);
export const toolApprovalPreviewSchema = toolApprovalDisplaySchema
  .safeExtend({
    targetVersions: toolApprovalTargetVersionsSchema,
    dataLevel: documentDataLevelSchema,
  })
  .refine(bounded, '批准预览不能超过64 KiB。');
export type ToolApprovalPreview = z.infer<typeof toolApprovalPreviewSchema>;
export const toolApprovalParamsSchema = z.object({ id }).strict();
export const toolApprovalDecisionInputSchema = z
  .object({
    requestKey: id,
    expectedVersion: z.number().int().positive().safe(),
    expectedContentHash: sha256Schema,
    action: toolApprovalActionSchema,
    reason: text(2000).optional(),
  })
  .strict()
  .refine(
    (value) => value.action === 'reject' || value.reason === undefined,
    '允许操作不接受拒绝原因。',
  );
export type ToolApprovalDecisionInput = z.infer<typeof toolApprovalDecisionInputSchema>;
export const toolApprovalViewSchema = z
  .object({
    id,
    conversationId: id,
    runId: id,
    toolName: toolNameSchema,
    toolVersion: text(128),
    version: z.number().int().positive().safe(),
    contentHash: sha256Schema,
    status: toolApprovalStatusSchema,
    preview: toolApprovalDisplaySchema,
    dataLevel: z.enum(['internal', 'confidential']),
    createdAt: instant,
    decidedAt: instant.nullable(),
  })
  .strict();
export const toolApprovalDecisionResultSchema = z
  .object({
    approvalId: id,
    decisionId: id,
    status: z.enum(['approved', 'rejected']),
    version: z.number().int().positive().safe(),
    replayed: z.boolean(),
    executed: z.literal(false),
  })
  .strict();
export const toolApprovalPendingResultSchema = z
  .object({
    approvalId: id,
    status: toolApprovalStatusSchema,
    message: text(500),
  })
  .strict();
