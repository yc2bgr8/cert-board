import { z } from 'zod';
import { agentCodeSchema, permissionModeSchema, conversationRecordSchema } from './workspace.js';

const id = z.string().uuid('对话、运行或请求编号无效，请刷新后重试。');
const sequence = z.number().int().positive().safe();
const validText = (value: string) => /^[^\uD800-\uDFFF]*$/u.test(value) && !value.includes('\0');
export const conversationUserTextSchema = z
  .string()
  .max(8000, '每次最多发送8000个字符，请分成较短的消息。')
  .refine((value) => value.trim().length > 0, '请输入消息内容。')
  .refine(validText, '消息包含无效字符，请使用完整文本。');

export const conversationCreateInputSchema = z
  .object({
    requestKey: id,
    title: z
      .string()
      .trim()
      .min(1, '请输入对话标题。')
      .max(255)
      .refine(validText, '标题包含无效字符。')
      .optional(),
    agentCode: agentCodeSchema.optional(),
    permissionMode: permissionModeSchema.default('ask'),
    goalId: id.optional(),
  })
  .strict();
export const conversationMessageInputSchema = z
  .object({ requestKey: id, text: conversationUserTextSchema })
  .strict();
export const conversationModeInputSchema = z
  .object({
    requestKey: id,
    expectedVersion: sequence,
    permissionMode: permissionModeSchema,
  })
  .strict();
export const conversationAnswerInputSchema = z
  .object({
    requestKey: id,
    runId: id,
    questionId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    text: conversationUserTextSchema,
  })
  .strict();
export const conversationStopInputSchema = z.object({ requestKey: id, runId: id }).strict();
export const conversationCreateResultSchema = z
  .object({
    conversation: conversationRecordSchema,
    permissionVersion: sequence,
    replayed: z.boolean(),
  })
  .strict();
export const conversationWriteResultSchema = z
  .object({
    conversationId: id,
    runId: id,
    messageId: id.nullable(),
    steeringId: id.nullable(),
    answerId: id.nullable(),
    kind: z.enum(['queued', 'steering', 'answer']),
    replayed: z.boolean(),
  })
  .strict()
  .refine(
    (value) =>
      value.kind === 'steering'
        ? value.messageId === null && value.steeringId !== null && value.answerId === null
        : value.messageId !== null &&
          value.steeringId === null &&
          (value.kind === 'answer') === (value.answerId !== null),
    '消息写入结果与处理方式不一致。',
  );
export const conversationModeResultSchema = z
  .object({
    conversationId: id,
    permissionMode: permissionModeSchema,
    version: sequence,
    replayed: z.boolean(),
  })
  .strict();
export const conversationStopResultSchema = z
  .object({
    conversationId: id,
    runId: id,
    stopped: z.boolean(),
    replayed: z.boolean(),
  })
  .strict();
export type ConversationCreateInput = z.infer<typeof conversationCreateInputSchema>;
export type ConversationMessageInput = z.infer<typeof conversationMessageInputSchema>;
export type ConversationModeInput = z.infer<typeof conversationModeInputSchema>;
export type ConversationAnswerInput = z.infer<typeof conversationAnswerInputSchema>;
export type ConversationStopInput = z.infer<typeof conversationStopInputSchema>;
export type ConversationWriteResult = z.infer<typeof conversationWriteResultSchema>;
export type ConversationCreateResult = z.infer<typeof conversationCreateResultSchema>;
export type ConversationModeResult = z.infer<typeof conversationModeResultSchema>;
export type ConversationStopResult = z.infer<typeof conversationStopResultSchema>;

export const steeringDeliverySchema = z
  .object({
    steeringId: id,
    messageId: id,
    seq: sequence,
    message: z.object({ role: z.literal('user'), content: conversationUserTextSchema }).strict(),
  })
  .strict();
export type SteeringDelivery = z.infer<typeof steeringDeliverySchema>;
export const steeringDeliveryBatchSchema = z
  .array(steeringDeliverySchema)
  .max(8)
  .refine(
    (items) => items.reduce((length, item) => length + item.message.content.length, 0) <= 32000,
    '单批插话内容超过上限，请分批投递。',
  );
