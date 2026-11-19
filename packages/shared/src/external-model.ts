import { z } from 'zod';
import { nanoAmountSchema } from './budget.js';
import { workspacePathSchema } from './workspace-path.js';

const id = z.string().uuid('编号无效，请重新选择。');
const instant = z.string().datetime({ offset: true });
const text = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1, '请填写内容。')
    .max(maximum, '内容超出长度限制。')
    .refine((value) => !value.includes('\0'), '内容含不支持的字符。');
export const externalModelIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const externalModelWordCategorySchema = z.enum([
  'customer',
  'product',
  'price',
  'contract',
  'other',
]);
export const externalModelWordInputSchema = z
  .object({
    phrase: text(120).refine((value) => !/[\r\n]/u.test(value), '保密词必须为一行。'),
    category: externalModelWordCategorySchema,
  })
  .strict();
export const externalModelWordSchema = externalModelWordInputSchema.extend({
  id,
  createdAt: instant,
});
export const externalModelWordListSchema = z.array(externalModelWordSchema).max(200);

export const externalModelReferenceSchema = z
  .object({
    title: text(250),
    url: z
      .url({ protocol: /^https$/ })
      .max(2048)
      .refine((value) => {
        const target = new URL(value);
        return !target.username && !target.password;
      }, '外部来源地址不可包含凭据。'),
  })
  .strict();
export const externalModelConversationInputSchema = z
  .object({ title: text(160), requestKey: id })
  .strict();
export const externalModelConversationSchema = z
  .object({
    id,
    title: text(160),
    updatedAt: instant,
  })
  .strict();
export const externalModelConversationListSchema = z.array(externalModelConversationSchema).max(50);
export const externalModelAttachmentSchema = z
  .object({ versionId: id, path: workspacePathSchema })
  .strict();
export const externalModelMessageInputSchema = z
  .object({
    requestKey: id,
    model: externalModelIdSchema,
    text: text(8000),
    search: z.boolean().default(true),
    attachments: z.array(externalModelAttachmentSchema).max(3).default([]),
  })
  .strict();
export const externalModelShareInputSchema = z
  .object({ conversationId: id, requestKey: id })
  .strict();
export const externalModelExchangeStatusSchema = z.enum([
  'reserved',
  'settled',
  'unknown',
  'not_sent',
]);
export const externalModelExchangeSchema = z
  .object({
    id,
    conversationId: id,
    model: externalModelIdSchema,
    originalText: text(8000),
    status: externalModelExchangeStatusSchema,
    replacementCount: z.number().int().nonnegative(),
    search: z.boolean(),
    answer: z.string().max(32000).nullable(),
    references: z.array(externalModelReferenceSchema).max(20),
    costNano: nanoAmountSchema.nullable(),
    createdAt: instant,
  })
  .strict();
export const externalModelExchangeListSchema = z.array(externalModelExchangeSchema).max(50);
export const externalModelArchiveSchema = z
  .object({
    id,
    conversationId: id,
    title: text(160),
    sent: z.record(z.string(), z.unknown()),
    returned: z.record(z.string(), z.unknown()).nullable(),
    createdAt: instant,
    status: externalModelExchangeStatusSchema,
    costNano: nanoAmountSchema.nullable(),
  })
  .strict();
export const externalModelArchivePageSchema = z
  .object({
    items: z.array(externalModelArchiveSchema).max(50),
    nextCursor: id.nullable(),
  })
  .strict();
export const externalModelSetupSchema = z
  .object({
    models: z.array(z.object({ id: externalModelIdSchema, label: text(80) }).strict()).max(20),
    readiness: z.enum(['fixture', 'pending_local_policy']),
    budget: z
      .object({
        month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
        limitNano: nanoAmountSchema,
        usedNano: nanoAmountSchema,
        reservedNano: nanoAmountSchema,
        blocked: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type ExternalModelWordInput = z.infer<typeof externalModelWordInputSchema>;
export type ExternalModelWord = z.infer<typeof externalModelWordSchema>;
export type ExternalModelReference = z.infer<typeof externalModelReferenceSchema>;
export type ExternalModelConversation = z.infer<typeof externalModelConversationSchema>;
export type ExternalModelMessageInput = z.infer<typeof externalModelMessageInputSchema>;
export type ExternalModelExchange = z.infer<typeof externalModelExchangeSchema>;
export type ExternalModelArchive = z.infer<typeof externalModelArchiveSchema>;
export type ExternalModelSetup = z.infer<typeof externalModelSetupSchema>;
