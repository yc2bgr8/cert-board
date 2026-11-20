import { z } from 'zod';
import { documentCitationSchema, structuredClaimSchema } from './checks.js';
import { workspacePathSchema } from './workspace-path.js';

const text = (limit: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(limit)
    .refine((value) => !value.includes('\0') && /^[^\uD800-\uDFFF]*$/u.test(value));
const key = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);

export const subagentRunInputSchema = z
  .object({
    tasks: z
      .array(z.object({ key, title: text(80), assignment: text(1500) }).strict())
      .min(2)
      .max(4),
  })
  .strict()
  .refine(
    ({ tasks }) => new Set(tasks.map((task) => task.key)).size === tasks.length,
    '每个子任务的 key 必须不同。',
  );
export type SubagentTask = z.infer<typeof subagentRunInputSchema>['tasks'][number];

const citation = documentCitationSchema.extend({
  quote: documentCitationSchema.shape.quote.refine((quote) => quote.length <= 512),
});
const claim = structuredClaimSchema.extend({
  value: z.union([text(300), z.number().finite()]),
  sources: z.array(citation).max(2),
});
export const subagentReportSchema = z
  .object({
    summary: text(600),
    claims: z.array(claim).max(4),
    missing: z.array(text(200)).max(4),
    drafts: z
      .array(z.object({ path: workspacePathSchema, content: text(1500) }).strict())
      .max(2)
      .default([]),
  })
  .strict();
export type SubagentReport = z.infer<typeof subagentReportSchema>;
