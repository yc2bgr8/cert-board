import { z } from 'zod';

const scope = z.enum(['project', 'department']).default('project');
const market = z.enum(['US', 'CA']);
export const certQueryInputSchema = z.discriminatedUnion('template', [
  z.strictObject({
    template: z.literal('credentials_expiring'),
    scope,
    days: z.number().int().min(0).max(7305),
  }),
  z.strictObject({
    template: z.literal('model_market_status'),
    scope,
    modelCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9.-]{1,31}$/u),
  }),
  z.strictObject({ template: z.literal('market_sellable_models'), scope, market }),
  z.strictObject({ template: z.literal('overdue_milestones'), scope }),
  z.strictObject({ template: z.literal('pending_my_reviews'), scope }),
  z.strictObject({ template: z.literal('unsupported'), scope }),
]);
export type CertQueryInput = z.infer<typeof certQueryInputSchema>;

export const certQueryTemplateSchema = z.enum(
  certQueryInputSchema.options.map((item) => item.shape.template.value),
);
const queryStatus = z.enum(['complete', 'partial', 'unanswerable']);
const gaps = z
  .array(
    z.enum([
      'template_unavailable',
      'project_required',
      'subject_unverified',
      'coverage_unverified',
      'records_incomplete',
      'results_truncated',
    ]),
  )
  .max(6);
const catalogVersion = z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/u);
const asOf = z.iso.datetime({ offset: true });

export const certQuerySourceSchema = z.strictObject({
  table: z.enum(['credential', 'market_authorization', 'cert_milestone', 'review_card']),
  id: z.uuid(),
  version: z.number().int().positive(),
});
const value = z.union([z.string().max(280), z.number().finite(), z.boolean(), z.null()]);
export const certQueryRowSchema = z.strictObject({
  source: certQuerySourceSchema,
  basis: certQuerySourceSchema.optional(),
  fields: z
    .record(z.string().min(1).max(40), value)
    .refine((fields) => Object.keys(fields).length <= 14),
});

export const certQueryResultSchema = z.strictObject({
  status: queryStatus,
  template: certQueryTemplateSchema,
  catalogVersion,
  scope: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('project'), projectId: z.uuid().nullable() }),
    z.strictObject({ kind: z.literal('department') }),
  ]),
  asOf,
  method: z.string().min(1).max(450),
  units: z.record(z.string().min(1).max(40), z.string().min(1).max(32)),
  gaps,
  truncated: z.boolean(),
  rows: z.array(certQueryRowSchema).max(100),
});
export type CertQueryResult = z.infer<typeof certQueryResultSchema>;

// 运行事件只保存口径索引和覆盖状态，原始参数和台账行留在工具回执。
export const certQueryEventSchema = z.strictObject({
  status: queryStatus,
  template: certQueryTemplateSchema,
  catalogVersion,
  scope: z.enum(['project', 'department']),
  asOf,
  gaps,
  truncated: z.boolean(),
});
export type CertQueryEvent = z.infer<typeof certQueryEventSchema>;

export const publicCertQueryReceiptSchema = certQueryEventSchema.extend({
  method: z.string().min(1).max(450).optional(),
});
export type PublicCertQueryReceipt = z.infer<typeof publicCertQueryReceiptSchema>;
