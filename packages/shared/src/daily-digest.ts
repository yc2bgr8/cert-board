import { z } from 'zod';
import { memberNotificationSnapshotSchema } from './conversation-read.js';

export const dailyDigestLimit = 20;
const resource = z.strictObject({
  id: z.uuid(),
  projectId: z.uuid(),
  conversationId: z.uuid().nullable(),
  title: z.string().min(1).max(255),
});
export const dailyDigestContentSchema = z.strictObject({
  completed: resource.array().max(dailyDigestLimit),
  pending: memberNotificationSnapshotSchema.shape.items.element.array().max(dailyDigestLimit),
  tomorrow: resource
    .extend({
      dueOn: z.iso.date(),
      jurisdictionTz: z.string().min(1).max(100),
    })
    .array()
    .max(dailyDigestLimit),
  localTestMessages: resource.array().max(dailyDigestLimit),
  truncated: z.boolean(),
});
export const dailyDigestViewSchema = dailyDigestContentSchema.extend({
  date: z.iso.date(),
  generatedAt: z.iso.datetime(),
});
export const dailyDigestResponseSchema = z.strictObject({
  digest: dailyDigestViewSchema.nullable(),
});
export type DailyDigestContent = z.infer<typeof dailyDigestContentSchema>;
