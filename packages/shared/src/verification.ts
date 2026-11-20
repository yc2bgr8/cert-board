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
    waitMinutes: z.number().int().min(1).max(240).optional(),
    models: z.array(verificationModelPreferenceSchema).min(2).max(8),
  })
  .strict();
export const verificationSettingsSchema = verificationSettingsInputSchema.extend({
  waitMinutes: z.number().int().min(1).max(240).default(60),
  catalog: z.array(verificationModelSchema).max(8),
  channelStatus: verificationChannelStatusSchema,
  unavailableReason: note(240).optional(),
  usage: z
    .array(z.object({ model: externalModelIdSchema, calls: z.number().int().nonnegative() }))
    .max(8),
});
export const verificationRoomStatusSchema = z.enum(['discussing', 'completed', 'paused']);
export const verificationOriginSchema = z
  .object({
    kind: z.enum(['agent', 'review']),
    conversationId: id,
    runId: id,
    reviewId: id.nullable(),
    deadlineAt: instant.optional(),
  })
  .strict();
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
    origin: verificationOriginSchema.nullable().default(null),
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
export const verificationSourceCheckSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('verified'),
      documentId: id,
      version: z.number().int().positive(),
      page: z.literal(1),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .strict(),
  z
    .object({
      status: z.enum([
        'excerpt_missing',
        'excerpt_mismatch',
        'source_unavailable',
        'scope_unavailable',
      ]),
    })
    .strict(),
]);
export const checkedVerificationSourceSchema = verificationSourceSchema.extend({
  check: verificationSourceCheckSchema.optional(),
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
    omitted: z
      .object({
        issues: z.number().int().nonnegative(),
        human: z.number().int().nonnegative(),
        earlierHistory: z.boolean(),
      })
      .strict()
      .default({ issues: 0, human: 0, earlierHistory: false }),
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
                sources: z.array(checkedVerificationSourceSchema).max(8),
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
export const verificationConsultInputSchema = z.object({ question: note(3000) }).strict();
export const verificationReviewInputSchema = verificationConsultInputSchema.extend({
  requestKey: id,
});
export const verificationTicketSchema = z
  .object({
    roomId: id,
    status: z.enum(['waiting', 'unavailable']),
    reason: note(240).nullable(),
  })
  .strict();
export const verificationLinkListSchema = z
  .array(
    z
      .object({
        room: verificationRoomSchema,
        result: z.enum(['pending', 'available', 'unavailable']),
        summary: note(2000).nullable(),
        sources: z.array(checkedVerificationSourceSchema).max(6),
        counts: z
          .object({
            trusted: z.number().int().nonnegative(),
            disputed: z.number().int().nonnegative(),
            unverified: z.number().int().nonnegative(),
            human: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
  )
  .max(20);
export const verificationLinkPageSchema = z
  .object({ items: verificationLinkListSchema, nextCursor: id.nullable() })
  .strict();

export type VerificationModel = z.infer<typeof verificationModelSchema>;
export type VerificationMessage = z.infer<typeof verificationMessageSchema>;
export type VerificationClaim = z.infer<typeof verificationClaimSchema>;
export type VerificationSource = z.infer<typeof verificationSourceSchema>;
export const sourceCheckKey = (source: VerificationSource) =>
  JSON.stringify([source.url, source.excerpt ?? null]);
export type CheckedVerificationSource = z.infer<typeof checkedVerificationSourceSchema>;
export function verificationArchiveKey(source: CheckedVerificationSource) {
  const proof = source.check;
  return proof?.status === 'verified'
    ? JSON.stringify([proof.documentId, proof.version, proof.page, source.excerpt ?? null])
    : null;
}
export type VerificationSourceCheck = z.infer<typeof verificationSourceCheckSchema>;
export type VerificationReply = z.infer<typeof verificationReplySchema>;
export type VerificationConclusion = z.infer<typeof verificationConclusionSchema>;
export type VerificationRoom = z.infer<typeof verificationRoomSchema>;
export type VerificationDetail = z.infer<typeof verificationDetailSchema>;
export type VerificationSettings = z.infer<typeof verificationSettingsSchema>;
export type VerificationSettingsInput = z.infer<typeof verificationSettingsInputSchema>;
export type VerificationCreate = z.infer<typeof verificationCreateSchema>;
export type VerificationMessageInput = z.infer<typeof verificationMessageInputSchema>;
export type VerificationOrigin = z.infer<typeof verificationOriginSchema>;
export type VerificationTicket = z.infer<typeof verificationTicketSchema>;
export type VerificationLinkView = z.infer<typeof verificationLinkListSchema>[number];
