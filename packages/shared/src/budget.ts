import { z } from 'zod';

const id = z.string().uuid('计量请求或运行编号无效。');
const count = z.number().int().nonnegative().safe();
export const nanoAmountSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,17})$/, '费用必须为非负整数 nanoUSD 字符串。');
export const decimalUsdSchema = z
  .string()
  .regex(
    /^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,9})?$/,
    '美元金额必须为非负十进制字符串，最多 9 位小数。',
  );
export const budgetPricesSchema = z
  .object({
    inputUsdPerMillion: decimalUsdSchema,
    cacheReadUsdPerMillion: decimalUsdSchema,
    outputUsdPerMillion: decimalUsdSchema,
  })
  .strict();
export type BudgetPrices = z.infer<typeof budgetPricesSchema>;
export const budgetUsageSchema = z
  .object({ inputTokens: count, cacheReadTokens: count, outputTokens: count })
  .strict()
  .refine((value) => value.cacheReadTokens <= value.inputTokens, '缓存 token 不能多于输入 token。');
export type BudgetUsage = z.infer<typeof budgetUsageSchema>;
export const cumulativeUsageSchema = z
  .object({ steps: count, totalTokens: count, costNano: nanoAmountSchema.nullable() })
  .strict();
export type CumulativeUsage = z.infer<typeof cumulativeUsageSchema>;
export const budgetLimitsSchema = z
  .object({
    maxSteps: count.positive(),
    maxTokens: count.positive(),
    maxCostNano: nanoAmountSchema.refine((value) => BigInt(value) > 0n, '运行费用上限必须大于零。'),
  })
  .strict();

export const budgetEnvironmentSchema = z.enum(['development', 'test', 'production']);
export const developmentBudgetEnvironmentSchema = z.enum(['development', 'test'], {
  error: '默认预算种子只允许用于开发或测试，生产必须另行批准额度。',
});
export const usageLedgerStatusSchema = z.enum(['reserved', 'settled', 'unknown', 'not_sent']);
export const budgetIncompleteReasonSchema = z.enum([
  'missing_usage',
  'missing_price',
  'request_uncertain',
  'reservation_exceeded',
  'timeout',
  'aborted',
  'provider_error',
  'manual_stop',
]);
const requestIdentity = { requestKey: id, runId: id, userId: id };
export const budgetReserveSchema = z
  .object({
    ...requestIdentity,
    modelId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/, '模型编号格式无效，不能包含正文或换行。'),
    purpose: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, '计量用途格式无效。'),
    estimatedInputTokens: count,
    maxOutputTokens: count,
    prices: budgetPricesSchema,
  })
  .strict();
export type BudgetReserve = z.infer<typeof budgetReserveSchema>;
export const budgetSettleSchema = z
  .object({
    ...requestIdentity,
    inputTokens: count,
    cacheReadTokens: count,
    outputTokens: count,
    actualCostNano: nanoAmountSchema.optional(),
  })
  .strict()
  .refine((value) => value.cacheReadTokens <= value.inputTokens, '缓存 token 不能多于输入 token。');
export type BudgetSettle = z.infer<typeof budgetSettleSchema>;
const reconciliationIdentity = {
  ledgerId: id,
  evidence: z
    .string()
    .trim()
    .min(1, '请填写核账依据。')
    .max(500, '核账依据不能超过 500 字。')
    .refine(
      (value) =>
        [...value].every((character) => {
          const code = character.codePointAt(0)!;
          return code >= 32 && (code < 127 || code >= 160) && code !== 0x2028 && code !== 0x2029;
        }),
      '核账依据必须为一行说明。',
    ),
};
export const budgetReconcileSchema = z
  .discriminatedUnion('outcome', [
    z
      .object({
        ...reconciliationIdentity,
        outcome: z.literal('charged'),
        actualCostNano: nanoAmountSchema,
        inputTokens: count,
        cacheReadTokens: count,
        outputTokens: count,
      })
      .strict(),
    z.object({ ...reconciliationIdentity, outcome: z.literal('not_sent') }).strict(),
    z.object({ ...reconciliationIdentity, outcome: z.literal('reserved_estimate') }).strict(),
  ])
  .refine(
    (value) => value.outcome !== 'charged' || value.cacheReadTokens <= value.inputTokens,
    '缓存 token 不能多于输入 token。',
  );
export type BudgetReconciliationInput = z.infer<typeof budgetReconcileSchema>;
export const budgetIncompleteSchema = z
  .object({ ...requestIdentity, reasonCode: budgetIncompleteReasonSchema })
  .strict();
export type BudgetIncomplete = z.infer<typeof budgetIncompleteSchema>;
export const budgetReservationSchema = z
  .object({
    id,
    status: usageLedgerStatusSchema,
    reservedNano: nanoAmountSchema,
    dispatchAllowed: z.boolean(),
    newReservation: z.boolean(),
  })
  .strict()
  .refine(
    (value) => !value.dispatchAllowed || (value.newReservation && value.status === 'reserved'),
    '只有新建的有效预占才能发出模型请求，不能重放旧请求。',
  );
export type BudgetReservation = z.infer<typeof budgetReservationSchema>;
