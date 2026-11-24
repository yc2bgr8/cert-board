import { z } from 'zod';

export const opsAlertKeySchema = z.enum([
  'service_database',
  'service_storage',
  'service_docsvc',
  'service_sandbox',
  'service_fetcher',
  'deadline_stale',
  'queue_backlog',
  'queue_failures',
  'wake_failures',
  'gateway_errors',
  'gateway_timeout',
  'gateway_credit',
  'monthly_budget',
  'disk_low',
  'backup_failed',
]);
export const opsAlertLevelSchema = z.enum(['warning', 'critical']);
export const opsAlertDetailSchema = z.string().min(1).max(400);
export const opsAlertSchema = z.strictObject({
  key: opsAlertKeySchema,
  level: opsAlertLevelSchema,
  detail: opsAlertDetailSchema,
  openedAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
});
export const opsAlertResponseSchema = z.strictObject({
  checkedAt: z.iso.datetime().nullable(),
  stale: z.boolean(),
  alerts: opsAlertSchema.array().max(15),
});
export type OpsAlertKey = z.infer<typeof opsAlertKeySchema>;
export type OpsAlertLevel = z.infer<typeof opsAlertLevelSchema>;
