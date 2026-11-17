import { describe, expect, it } from 'vitest';
import {
  estimateCostNano,
  evaluateCumulativeBudget,
  nanoToUsd,
  pickBeijingMonth,
  usdToNano,
} from './meter.js';

describe('精确费用计量与累计预算', () => {
  const prices = {
    inputUsdPerMillion: '0.15',
    cacheReadUsdPerMillion: '0.016',
    outputUsdPerMillion: '0.47',
  };
  const limits = { maxSteps: 60, maxTokens: 400_000, maxCostNano: '1000000000' };
  it('百万token价格单位正确，输入和输出各百万合计0.62美元', () => {
    expect(
      estimateCostNano(
        { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 1_000_000 },
        prices,
      ),
    ).toBe(620_000_000n);
  });
  it('缓存包含在输入总量中，不重复计费；每项向上取整', () => {
    expect(
      estimateCostNano(
        { inputTokens: 1_000_000, cacheReadTokens: 500_000, outputTokens: 0 },
        prices,
      ),
    ).toBe(83_000_000n);
    expect(
      estimateCostNano(
        { inputTokens: 1, cacheReadTokens: 0, outputTokens: 0 },
        { ...prices, inputUsdPerMillion: '0.000001' },
      ),
    ).toBe(1n);
  });
  it('金额转换保留精确小数，不经过浮点运算', () => {
    expect(usdToNano('10.000000001')).toBe(10_000_000_001n);
    expect(nanoToUsd(10_000_000_001n)).toBe('10.000000001');
    expect(nanoToUsd(0n)).toBe('0');
    expect(nanoToUsd(620_000_000n)).toBe('0.62');
  });
  it('缺价格、负数、小数token或缓存超过输入均不能计算为零', () => {
    expect(() => usdToNano('-1')).toThrow();
    expect(() => usdToNano('1e-3')).toThrow();
    expect(() => usdToNano('0.0000000001')).toThrow();
    expect(() => nanoToUsd(-1n)).toThrow();
    expect(() =>
      estimateCostNano({ inputTokens: 1, cacheReadTokens: 2, outputTokens: 0 }, prices),
    ).toThrow();
    expect(() =>
      estimateCostNano({ inputTokens: 0.5, cacheReadTokens: 0, outputTokens: 0 }, prices),
    ).toThrow();
    expect(() =>
      estimateCostNano(
        { inputTokens: 1, cacheReadTokens: 0, outputTokens: 0 },
        { ...prices, inputUsdPerMillion: '' },
      ),
    ).toThrow();
  });
  it('Pi累计快照重复送入不重复累加', () => {
    const snapshot = { steps: 7, totalTokens: 33_000, costNano: '620000000' };
    for (let turn = 0; turn < 5; turn++)
      expect(evaluateCumulativeBudget(snapshot, limits)).toEqual({ stop: false, reason: null });
    expect(evaluateCumulativeBudget({ ...snapshot, costNano: '1000000000' }, limits)).toEqual({
      stop: true,
      reason: 'cost',
    });
  });
  it.each([
    [{ steps: 60, totalTokens: 33_000, costNano: '1' }, 'steps'],
    [{ steps: 7, totalTokens: 400_000, costNano: '1' }, 'tokens'],
    [{ steps: 7, totalTokens: 33_000, costNano: null }, 'metering_incomplete'],
  ] as const)('达到上限或计量不完整时停止', (usage, reason) => {
    expect(evaluateCumulativeBudget(usage, limits)).toEqual({ stop: true, reason });
  });
  it('按北京时间切换月份而不是服务器UTC月份', () => {
    expect(pickBeijingMonth(new Date('2026-11-30T15:59:59.999Z'))).toBe('2026-11');
    expect(pickBeijingMonth(new Date('2026-11-30T16:00:00.000Z'))).toBe('2026-12');
    expect(() => pickBeijingMonth(new Date('invalid'))).toThrow();
  });
});
