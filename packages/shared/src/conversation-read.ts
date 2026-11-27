import { z } from 'zod';
import { publicCertQueryReceiptSchema } from './cert-query.js';
import { deadlineNoticeSchema } from './deadlines.js';
import { skillRollbackProposalSchema } from './skill-rollback.js';

const id = z.string().uuid();
const count = z.number().int().nonnegative().safe();
const instant = z.string().datetime({ offset: true });
const text = (maximum: number) => z.string().max(maximum);
export const conversationReadParamsSchema = z.object({ id }).strict();
export const conversationEventQuerySchema = z
  .object({
    afterSeq: z
      .string()
      .regex(/^(?:0|[1-9][0-9]{0,15})$/)
      .refine((value) => Number.isSafeInteger(Number(value)))
      .optional(),
  })
  .strict();
export const conversationListQuerySchema = z
  .object({
    cursor: id.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(30),
    scope: z.enum(['unassigned', 'all']).default('unassigned'),
  })
  .strict();
export const conversationPublicRecordSchema = z
  .object({
    id,
    projectId: id.nullable(),
    goalId: id.nullable(),
    userId: id,
    ownerName: text(120),
    title: text(255),
    agentCode: z.enum(['registration', 'maintenance']),
    permissionMode: z.enum(['read_only', 'ask', 'full']),
    status: z.enum(['active', 'archived']),
    maxDataLevel: z.enum(['internal', 'confidential']),
    version: count.positive(),
    permissionVersion: count.positive(),
    currentRunId: id.nullable(),
    lastMessageSeq: count,
    lastEventSeq: count,
    createdAt: instant,
    updatedAt: instant,
    canWrite: z.boolean(),
  })
  .strict();
export const conversationPublicListSchema = z
  .object({
    items: z.array(conversationPublicRecordSchema).max(50),
    hasMore: z.boolean(),
    nextCursor: id.nullable(),
  })
  .strict();
export const conversationPublicHistoryQuerySchema = z
  .object({
    afterSeq: z.coerce.number().int().nonnegative().safe().default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export const conversationPublicMessageSchema = z
  .object({
    id,
    runId: id,
    userId: id,
    seq: count.positive(),
    createdAt: instant,
    role: z.enum(['user', 'assistant']),
    text: text(262144),
  })
  .strict();
export const conversationPublicHistorySchema = z
  .object({
    items: z.array(conversationPublicMessageSchema).max(100),
    hasMore: z.boolean(),
    nextAfterSeq: count.positive().nullable(),
  })
  .strict();
const runStatus = z.enum([
  'queued',
  'running',
  'waiting',
  'completed',
  'failed',
  'stopped',
  'budget_exhausted',
]);
const callId = text(128).regex(/^[A-Za-z0-9_.:-]+$/);
const base = { id, conversationId: id, runId: id, seq: count.positive(), createdAt: instant };
const tool = z
  .object({
    name: text(64)
      .regex(/^[a-z][a-z0-9_]*$/)
      .optional(),
    callId: callId.optional(),
    awaitingApproval: z.literal(true).optional(),
    summary: text(400),
  })
  .strict();
const event = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.object({ ...base, type: z.literal(type), payload }).strict();
export const conversationPublicEventSchema = z.discriminatedUnion('type', [
  event(
    'user_message',
    z
      .object({ content: text(262144), messageId: id.optional(), steeringId: id.optional() })
      .strict(),
  ),
  event(
    'assistant_message',
    z.object({ content: text(262144), messageId: id.optional() }).strict(),
  ),
  event('model_started', z.object({ summary: text(400) }).strict()),
  event('tool_started', tool),
  event('tool_completed', tool.extend({ certQuery: publicCertQueryReceiptSchema.optional() })),
  event('tool_failed', tool),
  event(
    'plan_updated',
    z
      .object({
        steps: z
          .array(
            z
              .object({ title: text(160), status: z.enum(['pending', 'running', 'completed']) })
              .strict(),
          )
          .max(12),
        progress: text(400),
      })
      .strict(),
  ),
  event(
    'question',
    z
      .object({
        questionId: callId.optional(),
        question: text(1200),
        options: z.array(text(160)).max(6),
      })
      .strict(),
  ),
  event('approval_requested', z.object({ approvalId: id.optional(), summary: text(400) }).strict()),
  event(
    'approval_resolved',
    z
      .object({ approvalId: id.optional(), executed: z.boolean().optional(), summary: text(400) })
      .strict(),
  ),
  event('review_submitted', z.object({ reviewId: id.optional(), summary: text(400) }).strict()),
  event(
    'run_status',
    z
      .object({
        status: runStatus.optional(),
        reviewId: id.optional(),
        approvalId: id.optional(),
        questionId: callId.optional(),
        verificationRoomId: id.optional(),
        pendingSteeringCount: count.optional(),
        summary: text(400),
      })
      .strict(),
  ),
  event('progress', z.object({ summary: text(400) }).strict()),
  event('changes', z.object({ summary: text(400), workspaceVersion: id.optional() }).strict()),
  event(
    'question_answered',
    z
      .object({ summary: text(400), questionId: callId.optional(), newRunId: id.optional() })
      .strict(),
  ),
  event(
    'permission_changed',
    z
      .object({
        summary: text(400),
        permissionMode: z.enum(['read_only', 'ask', 'full']).optional(),
        permissionVersion: count.positive().optional(),
      })
      .strict(),
  ),
]);
export type ConversationPublicEvent = z.infer<typeof conversationPublicEventSchema>;
export const memberNotificationSnapshotSchema = z
  .object({
    generatedAt: instant,
    items: z
      .array(
        z
          .object({
            id,
            kind: z.enum([
              'approval',
              'question',
              'blocked',
              'review',
              'proposal',
              'deadline',
              'verification',
              'outbound',
              'skill',
            ]),
            conversationId: id.nullable(),
            projectId: id.nullable(),
            createdAt: instant,
            deadline: deadlineNoticeSchema.optional(),
            verification: z
              .object({ roomId: id, kind: z.enum(['blocked', 'late']) })
              .strict()
              .optional(),
            skillRollback: skillRollbackProposalSchema
              .pick({ skillId: true, activeVersion: true })
              .optional(),
          })
          .strict()
          .refine(
            ({ kind, deadline, verification, skillRollback, conversationId }) =>
              (kind === 'deadline') === Boolean(deadline) &&
              (kind === 'verification') === Boolean(verification) &&
              (kind === 'skill') === Boolean(skillRollback) &&
              (kind === 'skill') === (conversationId === null),
          ),
      )
      .max(60),
    truncated: z.boolean(),
  })
  .strict();
