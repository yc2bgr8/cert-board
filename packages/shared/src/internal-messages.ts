import { z } from 'zod';
import {
  proposalCreateSchema,
  outboundMessageStatusSchema,
  localTestReceiptSchema,
} from './proposals.js';

export const internalMessageInputSchema = proposalCreateSchema;
export type InternalMessageInput = z.infer<typeof internalMessageInputSchema>;
export const internalMessageQueuedSchema = z
  .object({
    queueId: z.string().uuid(),
    status: z.literal('queued'),
    channel: z.literal('local_test'),
    recipientName: z.string().min(1).max(120),
    sent: z.literal(false),
  })
  .strict();
export const internalMessageProcessSchema = z
  .object({
    queueId: z.string().uuid(),
    status: outboundMessageStatusSchema,
    attempts: z.number().int().min(0).max(1),
    reason: z.string().max(500).nullable(),
    receipt: localTestReceiptSchema.nullable(),
  })
  .strict();
export type InternalMessageProcess = z.infer<typeof internalMessageProcessSchema>;
export const internalMessageUndoSchema = z.object({ created: z.literal(false) }).strict();
