import { z } from 'zod';
import { agentCodeSchema } from './workspace.js';
import { externalModelIdSchema, externalModelReferenceSchema } from './external-model.js';

const id = z.string().uuid();
const instant = z.string().datetime({ offset: true });
const note = (limit: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(limit)
    .refine((value) => !/[\p{Surrogate}\0]/u.test(value));

export const verificationChannelSchema = z.enum(['cursor', 'gateway']);
export const verificationChannelStatusSchema = z.enum([
  'ready',
  'fixture',
  'not_installed',
  'not_signed_in',
  'privacy_unverified',
  'quota',
  'unavailable',
]);
export const verificationModelSchema = z
  .object({
    id: externalModelIdSchema,
    label: note(80),
    family: externalModelIdSchema,
    channel: verificationChannelSchema,
  })
  .strict();
export const verificationModelPreferenceSchema = z
  .object({
    id: externalModelIdSchema,
    channel: verificationChannelSchema,
    enabled: z.boolean(),
    defaultParticipant: z.boolean(),
  })
  .strict();
export const verificationSettingsInputSchema = z
  .object({
    autoRounds: z.number().int().min(1).max(20),
    models: z.array(verificationModelPreferenceSchema).min(2).max(8),
  })
  .strict();
export const verificationSettingsSchema = verificationSettingsInputSchema.extend({
  catalog: z.array(verificationModelSchema).max(8),
  channelStatus: verificationChannelStatusSchema,
  usage: z
    .array(z.object({ model: externalModelIdSchema, calls: z.number().int().nonnegative() }))
    .max(8),
});
export const verificationRoomStatusSchema = z.enum(['discussing', 'completed', 'paused']);
export const verificationRoomSchema = z
  .object({
    id,
    projectId: id.nullable(),
    projectName: note(160).nullable(),
    host: agentCodeSchema,
    title: note(160),
    startedBy: note(120),
    status: verificationRoomStatusSchema,
    activeModel: externalModelIdSchema.nullable(),
    stoppedBy: note(120).nullable(),
    humanJoined: z.boolean(),
    updatedAt: instant,
  })
  .strict();
export const verificationRoomPageSchema = z
  .object({
    items: z.array(verificationRoomSchema).max(50),
    nextCursor: z.string().max(80).nullable(),
  })
  .strict();
export const verificationCreateSchema = z
  .object({
    requestKey: id,
    question: note(8000),
    projectId: id.nullable().default(null),
  })
  .strict();
export const verificationMessageInputSchema = z
  .object({
    requestKey: id,
    text: note(8000),
    mention: z
      .union([externalModelIdSchema, z.literal('host')])
      .nullable()
      .default(null),
  })
  .strict();
export const verificationInviteSchema = z.object({ model: externalModelIdSchema }).strict();
export const verificationSourceSchema = externalModelReferenceSchema.extend({
  excerpt: note(1500).optional(),
});
export const verificationClaimSchema = z
  .object({
    issue: note(160),
    statement: note(1200),
    stance: z.enum(['supports', 'disputes']),
    sources: z.array(verificationSourceSchema).max(8),
  })
  .strict();
export const verificationReplySchema = z
  .object({
    text: note(16000),
    claims: z.array(verificationClaimSchema).max(16),
  })
  .strict();
export const verificationMessageSchema = z
  .object({
    id,
    type: z.enum(['host', 'human', 'model', 'system', 'summary']),
    author: note(120),
    model: externalModelIdSchema.nullable(),
    round: z.number().int().positive().nullable(),
    channel: verificationChannelSchema.nullable(),
    text: note(32000),
    mention: externalModelIdSchema.nullable(),
    archiveId: id.nullable(),
    redactions: z.number().int().nonnegative(),
    sources: z.array(verificationSourceSchema).max(20),
    createdAt: instant,
  })
  .strict();
export const verificationConclusionSchema = z
  .object({
    summary: note(2000),
    items: z
      .array(
        z.object({
          category: z.enum(['trusted', 'disputed', 'unverified', 'human']),
          statement: note(8000),
          selection: note(1600).nullable(),
          evidence: z
            .array(
              z.object({
                messageId: id,
                author: note(120),
                statement: note(8000),
                sources: z.array(verificationSourceSchema).max(8),
              }),
            )
            .max(24),
        }),
      )
      .max(120),
    createdAt: instant,
  })
  .strict();
export const verificationDetailSchema = z
  .object({
    room: verificationRoomSchema,
    participants: z.array(verificationModelSchema).max(8),
    messages: z.array(verificationMessageSchema).max(100),
    nextCursor: id.nullable(),
    conclusion: verificationConclusionSchema.nullable(),
    autoRounds: z.number().int().min(1).max(20),
  })
  .strict();
export const verificationShareSchema = z.object({ conversationId: id, requestKey: id }).strict();

export type VerificationModel = z.infer<typeof verificationModelSchema>;
export type VerificationMessage = z.infer<typeof verificationMessageSchema>;
export type VerificationClaim = z.infer<typeof verificationClaimSchema>;
export type VerificationReply = z.infer<typeof verificationReplySchema>;
export type VerificationConclusion = z.infer<typeof verificationConclusionSchema>;
export type VerificationRoom = z.infer<typeof verificationRoomSchema>;
export type VerificationDetail = z.infer<typeof verificationDetailSchema>;
export type VerificationSettings = z.infer<typeof verificationSettingsSchema>;
export type VerificationSettingsInput = z.infer<typeof verificationSettingsInputSchema>;
export type VerificationCreate = z.infer<typeof verificationCreateSchema>;
export type VerificationMessageInput = z.infer<typeof verificationMessageInputSchema>;
