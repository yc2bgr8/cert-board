import { z } from 'zod';
import { authorizationActionSchema } from './auth.js';
import { permissionModeSchema } from './workspace.js';
import { documentDataLevelSchema } from './documents.js';
import { goalStatusSchema } from './projects.js';

export const toolEffectSchema = z.enum(['read', 'reversible_write', 'external', 'irreversible']);
export type ToolEffect = z.infer<typeof toolEffectSchema>;
export const toolNameSchema = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);
export const toolDescriptionSchema = z
  .object({
    purpose: z.string().min(1).max(1000),
    whenToUse: z.string().min(1).max(1000),
    avoid: z.string().min(1).max(1000),
    parameters: z.string().min(1).max(2000),
    example: z.json(),
  })
  .strict()
  .refine((value) => JSON.stringify(value.example).length <= 4000, '工具示例过长。');
export const toolMetadataSchema = z
  .object({
    name: toolNameSchema,
    version: z.string().min(1).max(128),
    publication: z.enum(['draft', 'published']),
    effect: toolEffectSchema,
    modes: z.array(permissionModeSchema).min(1).max(3),
    approvalInAsk: z.boolean(),
    outputDataLevel: z.enum(['public', 'internal', 'confidential', 'dynamic']),
    authorizationAction: authorizationActionSchema,
    description: toolDescriptionSchema,
  })
  .strict();
export type ToolMetadata = z.infer<typeof toolMetadataSchema>;
export const toolPolicyContextSchema = z
  .object({
    permissionMode: permissionModeSchema,
    approvalGranted: z.boolean(),
    goalStatus: goalStatusSchema.nullable(),
    hasUndo: z.boolean(),
    resourceAllowed: z.boolean(),
  })
  .strict();
export type ToolPolicyContext = z.infer<typeof toolPolicyContextSchema>;
export const toolCallContextSchema = z
  .object({
    runId: z.string().uuid(),
    callId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_.:-]+$/),
    userId: z.string().uuid(),
  })
  .strict();
export const toolCatalogContextSchema = toolCallContextSchema.omit({ callId: true });
export type ToolCallContext = z.infer<typeof toolCallContextSchema>;
export const toolVersionTokenSchema = z.union([
  z.number().int().nonnegative().safe().transform(String),
  z
    .string()
    .min(1)
    .max(128)
    .regex(/^(?:[0-9]{1,16}|[a-f0-9]{64})$/),
]);
export const undoCaptureSchema = z
  .object({
    targetType: z.string().regex(/^[a-z][a-z0-9_]{1,79}$/),
    targetId: z.string().uuid(),
    beforeState: z.json(),
    beforeVersion: toolVersionTokenSchema.nullable(),
  })
  .strict()
  .refine(
    (value) => JSON.stringify(value.beforeState).length <= 64000,
    '撤销快照过大，请保存内容引用而不是正文。',
  );
export type UndoCapture = z.infer<typeof undoCaptureSchema>;
export const toolExecutionResultSchema = z
  .object({
    data: z.json(),
    dataLevel: documentDataLevelSchema,
    afterVersion: toolVersionTokenSchema.optional(),
  })
  .strict()
  .refine(
    (value) => JSON.stringify(value.data).length <= 32000,
    '工具结果过长，请使用分页继续读取。',
  );
export const toolStoredPayloadSchema = z
  .object({
    status: z.enum(['completed', 'pending_proposal', 'pending_approval']),
    result: toolExecutionResultSchema,
  })
  .strict();
export const toolPolicyDecisionSchema = z
  .object({
    decision: z.enum(['allow', 'deny', 'propose', 'require_approval']),
    code: z.string().max(80),
    message: z.string().max(512),
  })
  .strict();
export type ToolPolicyDecision = z.infer<typeof toolPolicyDecisionSchema>;
