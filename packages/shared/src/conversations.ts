import { z } from 'zod';
import { chatMessageSchema } from './model-gateway.js';

const id = z.string().uuid('对话、运行或请求编号无效。');
const seq = z.number().int().positive().safe();
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export const conversationMessageSchema = chatMessageSchema.refine(
  (message) =>
    bytes(message) <= 262144 &&
    (message.role !== 'assistant' ||
      message.content !== null ||
      Boolean(message.tool_calls?.length)),
  '消息过长或助手消息为空，请缩小本次输入。',
);
export const conversationEventTypes = [
  'user_message',
  'assistant_message',
  'model_started',
  'tool_started',
  'tool_completed',
  'tool_failed',
  'plan_updated',
  'question',
  'review_submitted',
  'run_status',
] as const;
export const conversationEventSchema = z
  .object({
    type: z.enum(conversationEventTypes),
    payload: z.record(z.string(), z.json()),
  })
  .strict()
  .superRefine((event, context) => {
    if (bytes(event) > 65536) {
      context.addIssue({ code: 'custom', message: '对话过程内容超过64 KiB，请只保留必要摘要。' });
      return;
    }
    const pending: unknown[] = [event.payload];
    while (pending.length) {
      const value = pending.pop();
      if (!value || typeof value !== 'object') continue;
      for (const [key, child] of Object.entries(value)) {
        if (
          /^(?:headers?|authorization|proxy-authorization|cookie|set-cookie|credentials?|password|api[_-]?key|secret|token)$/i.test(
            key,
          ) ||
          /(?:_KEY|_TOKEN|_SECRET)$/.test(key)
        ) {
          context.addIssue({
            code: 'custom',
            message: '对话过程不能保存请求头或凭据字段，请只选择业务结果。',
          });
          return;
        }
        pending.push(child);
      }
    }
  });
export type ConversationEvent = z.infer<typeof conversationEventSchema>;
export const conversationEventNotificationSchema = z
  .object({
    conversationId: id,
    eventId: id,
    seq,
  })
  .strict();
const appendContext = { runId: id, userId: id, requestKey: id };
export const appendConversationMessageSchema = z
  .object({
    ...appendContext,
    message: conversationMessageSchema,
  })
  .strict();
export const appendConversationEventSchema = z
  .object({
    ...appendContext,
    event: conversationEventSchema,
  })
  .strict();
export const conversationAppendResultSchema = z
  .object({
    id,
    conversationId: id,
    runId: id,
    seq,
    replayed: z.boolean(),
  })
  .strict();
const record = {
  id,
  conversationId: id,
  runId: id,
  userId: id,
  seq,
  dataLevel: z.enum(['internal', 'confidential']),
  createdAt: z.string().datetime({ offset: true }),
};
export const conversationMessageRecordSchema = z
  .object({
    ...record,
    message: conversationMessageSchema,
  })
  .strict();
export const conversationEventRecordSchema = z
  .object({
    ...record,
    event: conversationEventSchema,
  })
  .strict();
export const conversationHistoryOptionsSchema = z
  .object({
    afterSeq: z.number().int().nonnegative().safe().default(0),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
const page = { hasMore: z.boolean(), nextAfterSeq: seq.nullable() };
export const conversationMessageListSchema = z
  .object({
    ...page,
    items: z.array(conversationMessageRecordSchema).max(100),
  })
  .strict();
export const conversationEventListSchema = z
  .object({
    ...page,
    items: z.array(conversationEventRecordSchema).max(100),
  })
  .strict();
