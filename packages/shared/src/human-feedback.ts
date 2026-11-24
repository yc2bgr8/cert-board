import { z } from 'zod';

const target = z.strictObject({
  kind: z.enum(['message', 'review']),
  targetId: z.uuid(),
});
const rating = z.enum(['helpful', 'unhelpful']);
const reason = z
  .string()
  .trim()
  .min(1)
  .max(600)
  .refine((text) => !text.includes('\0') && /^[^\uD800-\uDFFF]*$/u.test(text));

export const humanFeedbackInputSchema = target
  .extend({
    requestKey: z.uuid(),
    rating,
    reason: reason.nullable(),
  })
  .refine(({ rating, reason }) => rating === 'unhelpful' || reason === null);

export const humanFeedbackResultSchema = target.extend({
  id: z.uuid(),
  rating,
  reason: reason.nullable(),
  createdAt: z.iso.datetime(),
});
export const humanFeedbackListSchema = z.strictObject({
  items: humanFeedbackResultSchema.array().max(100),
});
export type HumanFeedbackInput = z.infer<typeof humanFeedbackInputSchema>;
