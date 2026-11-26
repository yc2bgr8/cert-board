import { describe, expect, it } from 'vitest';
import {
  budgetIncompleteSchema,
  budgetPricesSchema,
  budgetReservationSchema,
  budgetReserveSchema,
  budgetSettleSchema,
  cumulativeUsageSchema,
  developmentBudgetEnvironmentSchema,
  nanoAmountSchema,
} from './budget.js';

const id = '10000000-0000-4000-8000-000000000001';
const request = { requestKey: id, runId: id, userId: id };
const prices = {
  inputUsdPerMillion: '0.15',
  cacheReadUsdPerMillion: '0.016',
  outputUsdPerMillion: '0.47',
};
describe('预算计量边界', () => {
  it('金额以精确字符串表示，缺价或非法数值不能默认为零', () => {
    expect(budgetPricesSchema.parse(prices)).toEqual(prices);
    expect(budgetPricesSchema.safeParse({ inputUsdPerMillion: '0.15' }).success).toBe(false);
    for (const value of ['-1', 'NaN', 'Infinity', '1e9', '1.1', '1000000000000000000'])
      expect(nanoAmountSchema.safeParse(value).success).toBe(false);
    expect(nanoAmountSchema.parse('10000000000')).toBe('10000000000');
  });
  it('预占只能使用完整请求身份和价目，调用方不能指定政策月份或夜间键', () => {
    const input = {
      ...request,
      modelId: 'qwen/qwen3.8-flash',
      purpose: 'agent',
      estimatedInputTokens: 1000,
      maxOutputTokens: 100,
      prices,
    };
    expect(budgetReserveSchema.safeParse(input).success).toBe(true);
    expect(budgetReserveSchema.safeParse({ ...input, nightKey: 'reset-budget' }).success).toBe(
      false,
    );
    expect(budgetReserveSchema.safeParse({ ...input, monthKey: '2099-01' }).success).toBe(false);
    expect(budgetReserveSchema.safeParse({ ...input, modelId: '正文\n不是模型编号' }).success).toBe(
      false,
    );
    expect(budgetReserveSchema.safeParse({ ...input, estimatedInputTokens: -1 }).success).toBe(
      false,
    );
  });
  it('缓存计量是输入子集，真实费用可以高于预占后再由服务冻结', () => {
    expect(
      budgetSettleSchema.safeParse({
        ...request,
        inputTokens: 10,
        cacheReadTokens: 11,
        outputTokens: 1,
      }).success,
    ).toBe(false);
    expect(
      budgetSettleSchema.safeParse({
        ...request,
        inputTokens: 10,
        cacheReadTokens: 0,
        outputTokens: 1,
        actualCostNano: '20000000000',
      }).success,
    ).toBe(true);
    expect(
      cumulativeUsageSchema.safeParse({ steps: 2, totalTokens: 100, costNano: null }).success,
    ).toBe(true);
  });
  it('重复预占不能授权第二次dispatch，未知费用原因仅接受固定代码', () => {
    const result = {
      id,
      status: 'reserved',
      reservedNano: '100',
      dispatchAllowed: true,
      newReservation: true,
    };
    expect(budgetReservationSchema.safeParse(result).success).toBe(true);
    expect(budgetReservationSchema.safeParse({ ...result, newReservation: false }).success).toBe(
      false,
    );
    expect(budgetReservationSchema.safeParse({ ...result, status: 'unknown' }).success).toBe(false);
    expect(
      budgetIncompleteSchema.safeParse({ ...request, reasonCode: 'missing_usage' }).success,
    ).toBe(true);
    expect(
      budgetIncompleteSchema.safeParse({ ...request, reasonCode: '原始响应正文或凭据' }).success,
    ).toBe(false);
    expect(budgetIncompleteSchema.safeParse({
      ...request, reasonCode: 'request_uncertain', cursorReplyFailure: 'invalid_json',
    }).success).toBe(true);
    expect(budgetIncompleteSchema.safeParse({
      ...request, reasonCode: 'request_uncertain', cursorReplyFailure: 'invalid_frame',
    }).success).toBe(true);
    expect(budgetIncompleteSchema.safeParse({
      ...request, reasonCode: 'request_uncertain', cursorReplyFailure: '原始响应正文或凭据',
    }).success).toBe(false);
  });
  it('默认运营额度不能自动用于生产', () => {
    expect(developmentBudgetEnvironmentSchema.safeParse('development').success).toBe(true);
    expect(developmentBudgetEnvironmentSchema.safeParse('test').success).toBe(true);
    expect(developmentBudgetEnvironmentSchema.safeParse('production').success).toBe(false);
  });
});
