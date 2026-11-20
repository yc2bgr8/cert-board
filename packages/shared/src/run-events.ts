import { z } from 'zod';
import { nanoAmountSchema } from './budget.js';
import { documentDataLevelSchema, sha256Schema } from './documents.js';

const id = z.string().uuid('运行或关联记录编号无效。');
const count = z.number().int().nonnegative().safe();
const instant = z.string().datetime({ offset: true });
export const runEventTypeSchema = z.enum([
  'run_started',
  'model_started',
  'model_completed',
  'tool_started',
  'tool_completed',
  'tool_failed',
  'run_waiting',
  'run_completed',
  'run_failed',
  'run_stopped',
  'budget_stopped',
]);
export const runEventReasonSchema = z.enum([
  'authorization_denied',
  'validation_failed',
  'version_conflict',
  'budget_limit',
  'metering_incomplete',
  'provider_unavailable',
  'timeout',
  'cancelled',
  'lease_expired',
  'lease_replaced',
  'internal_error',
]);
const eventFields = {
  type: runEventTypeSchema,
  invocationId: id.nullable().optional(),
  requestId: id.nullable().optional(),
  contentHash: sha256Schema.nullable().optional(),
  sandboxInputHashes: z.array(sha256Schema).max(16).nullable().optional(),
  sandboxOutputHashes: z.array(sha256Schema).max(32).nullable().optional(),
  dataLevel: documentDataLevelSchema.nullable().optional(),
  reasonCode: runEventReasonSchema.nullable().optional(),
  inputTokens: count.nullable().optional(),
  outputTokens: count.nullable().optional(),
  totalTokens: count.nullable().optional(),
  costNano: nanoAmountSchema.nullable().optional(),
  durationMs: count.nullable().optional(),
};
// 只把明确登记的字段写入执行记录；未知正文、参数和错误对象必须剔除。
export const runEventInputSchema = z.object(eventFields).strip();
export type RunEventInput = z.infer<typeof runEventInputSchema>;
export const runEventRecordSchema = z
  .object({ id, runId: id, seq: count.positive(), ...eventFields, createdAt: instant })
  .strict();
export type RunEventRecord = z.infer<typeof runEventRecordSchema>;
export const appendRunEventSchema = z
  .object({ runId: id, userId: id, event: runEventInputSchema })
  .strict();
export const runEventListOptionsSchema = z
  .object({
    afterSeq: z.coerce.number().int().nonnegative().safe().default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export const runEventListSchema = z
  .object({
    items: z.array(runEventRecordSchema).max(100),
    hasMore: z.boolean(),
    nextAfterSeq: count.positive().nullable(),
  })
  .strict()
  .refine((value) => value.hasMore === (value.nextAfterSeq !== null), '执行事件分页位置不一致。');

const leaseIdentity = { runId: id, userId: id, ownerId: id };
const ttlSeconds = z
  .number()
  .int()
  .min(5, '租约至少为 5 秒。')
  .max(300, '租约最多为 300 秒。')
  .default(60);
export const claimRunLeaseSchema = z.object({ ...leaseIdentity, ttlSeconds }).strict();
export const runLeaseIdentitySchema = z
  .object({ ...leaseIdentity, generation: count.positive() })
  .strict();
export const renewRunLeaseSchema = z
  .object({ ...leaseIdentity, generation: count.positive(), ttlSeconds })
  .strict();
export const runLeaseRecordSchema = z
  .object({ runId: id, ownerId: id, generation: count.positive(), expiresAt: instant })
  .strict();
export type RunLeaseIdentity = z.infer<typeof runLeaseIdentitySchema>;
export type RunLeaseRecord = z.infer<typeof runLeaseRecordSchema>;
