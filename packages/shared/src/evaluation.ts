import { z } from 'zod';

export const evaluationDimensionSchema = z.enum([
  'task_completion',
  'answer_quality',
  'evidence',
  'tool_reliability',
  'policy',
  'efficiency',
  'collaboration',
]);
export const evaluationStatusSchema = z.enum(['not_evaluated', 'passed', 'needs_review', 'failed']);
export type EvaluationStatus = z.infer<typeof evaluationStatusSchema>;

const evaluationFindingSchema = z.enum([
  'result_missing',
  'submission_invalid',
  'claim_unverified',
  'absence_without_read',
  'evidence_invalid',
  'evidence_unchecked',
  'tool_unpaired',
  'tool_failed',
  'readonly_write',
  'approval_missing',
  'external_unauthorized',
  'policy_not_observed',
  'usage_unmeasured',
  'budget_exceeded',
  'progress_unobserved',
  'review_missing',
  'semantic_downgrade',
]);
export const evaluationDimensionResultSchema = z.strictObject({
  status: evaluationStatusSchema,
  findings: z.array(evaluationFindingSchema).max(6),
});
export type EvaluationDimensionResult = z.infer<typeof evaluationDimensionResultSchema>;

export const deterministicEvaluationSchema = z.strictObject({
  dimensions: z.record(evaluationDimensionSchema, evaluationDimensionResultSchema),
  overall: evaluationStatusSchema,
});
export type DeterministicEvaluation = z.infer<typeof deterministicEvaluationSchema>;

export const semanticDimensionsSchema = z
  .partialRecord(evaluationDimensionSchema, z.enum(['passed', 'needs_review', 'failed']))
  .refine((dimensions) => Object.keys(dimensions).length > 0, '已完成的语义复核至少有一项维度。');
export const semanticEvaluationSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('not_evaluated') }),
  z.strictObject({
    status: z.literal('unavailable'),
    reason: z.enum([
      'model_unavailable',
      'same_model_family',
      'same_upstream_model',
      'invalid_response',
      'provider_failure',
    ]),
  }),
  z.strictObject({
    status: z.literal('completed'),
    dimensions: semanticDimensionsSchema,
  }),
]);
export type SemanticEvaluation = z.infer<typeof semanticEvaluationSchema>;

export const evaluationStatusViewSchema = z.strictObject({
  version: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/u),
  deterministic: deterministicEvaluationSchema,
  semantic: semanticEvaluationSchema,
  result: deterministicEvaluationSchema,
});
