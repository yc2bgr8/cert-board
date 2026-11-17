import { z } from 'zod';
import { sha256Schema } from './documents.js';
import { workspaceDataLevelSchema } from './workspace.js';

const idSchema = z.string().uuid('提案、目标或联系人编号无效，请重新选择。');
const versionSchema = z.number().int().positive().safe('版本号无效，请刷新后重试。');
const instantSchema = z.string().datetime({ offset: true });
const validText = (value: string) => /^[^\uD800-\uDFFF]*$/u.test(value) && !value.includes('\0');
const subjectSchema = z
  .string()
  .trim()
  .min(1, '请填写主题。')
  .max(200, '主题不能超过 200 字符。')
  .refine(
    (value) =>
      validText(value) &&
      [...value].every((char) => char.codePointAt(0)! >= 32 && char.codePointAt(0) !== 127),
    '主题不能包含换行或控制字符。',
  );
const bodySchema = z
  .string()
  .max(8000, '正文不能超过 8000 字符，请缩短后重新提交。')
  .refine((value) => validText(value) && value.trim().length > 0, '请提供非空且编码有效的正文。');

export const proposalStatusSchema = z.enum([
  'proposed',
  'approved',
  'executing',
  'done',
  'failed',
  'reconcile',
  'rejected',
  'expired',
]);
export const proposalDecisionActionSchema = z.enum(['approved', 'rejected']);
export const outboundMessageStatusSchema = z.enum([
  'queued',
  'done',
  'failed',
  'reconcile',
  'cancelled',
]);
export const proposalCreateSchema = z
  .object({ contactId: idSchema, subject: subjectSchema, body: bodySchema })
  .strict();
export type ProposalCreate = z.infer<typeof proposalCreateSchema>;
export const proposalToolResultSchema = z
  .object({
    proposalId: idSchema,
    version: versionSchema,
    status: z.literal('proposed'),
    channel: z.literal('local_test'),
    sent: z.literal(false),
  })
  .strict();

export const proposalRecordSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    goalId: idSchema,
    conversationId: idSchema,
    runId: idSchema,
    invocationId: idSchema,
    proposedBy: idSchema,
    contactId: idSchema,
    recipientVersion: versionSchema,
    recipientName: z.string().min(1).max(120),
    recipientAddress: z.string().min(1).max(255),
    channel: z.literal('local_test'),
    subject: subjectSchema,
    body: bodySchema,
    contentHash: sha256Schema,
    dataLevel: workspaceDataLevelSchema,
    status: proposalStatusSchema,
    version: versionSchema,
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .strict();
export type ProposalRecord = z.infer<typeof proposalRecordSchema>;

export const proposalParamsSchema = z.object({ id: idSchema }).strict();
export const proposalListOptionsSchema = z
  .object({
    cursor: idSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(50),
  })
  .strict();
export const proposalListSchema = z
  .object({
    items: z.array(proposalRecordSchema).max(50),
    hasMore: z.boolean(),
    nextCursor: idSchema.nullable(),
  })
  .strict()
  .refine(
    (value) => value.hasMore === (value.nextCursor !== null),
    '提案分页状态不一致，请重新读取。',
  );

export const proposalDecisionSchema = z
  .object({
    expectedVersion: versionSchema,
    action: proposalDecisionActionSchema,
    requestKey: idSchema,
  })
  .strict();
export type ProposalDecision = z.infer<typeof proposalDecisionSchema>;
export const proposalDecisionResultSchema = z
  .object({
    proposalId: idSchema,
    status: proposalStatusSchema,
    version: versionSchema,
    decisionId: idSchema,
    queueId: idSchema.nullable(),
    replayed: z.boolean(),
  })
  .strict();

export const goalOutboundControlSchema = z
  .object({ expectedVersion: versionSchema, paused: z.boolean() })
  .strict();
export type GoalOutboundControl = z.infer<typeof goalOutboundControlSchema>;
export const goalOutboundControlResultSchema = z
  .object({
    goalId: idSchema,
    paused: z.boolean(),
    version: versionSchema,
    resetProposalIds: z.array(idSchema).max(100),
    truncated: z.boolean(),
  })
  .strict();

export const localTestReceiptSchema = z
  .object({ id: idSchema, recordedAt: instantSchema, channel: z.literal('local_test') })
  .strict();
export const outboundProcessOptionsSchema = z
  .object({
    simulate: z
      .enum(['success', 'uncertain', 'failure'], { error: '本地测试结果类型无效。' })
      .default('success'),
  })
  .strict();
export const outboundProcessResultSchema = z
  .object({
    queueId: idSchema,
    proposalId: idSchema,
    status: outboundMessageStatusSchema,
    attempts: z.number().int().nonnegative().safe(),
    reason: z.string().max(500).nullable(),
    receipt: localTestReceiptSchema.nullable(),
  })
  .strict();
export type OutboundProcessResult = z.infer<typeof outboundProcessResultSchema>;
