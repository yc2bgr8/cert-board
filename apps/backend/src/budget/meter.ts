import type { z } from 'zod';
import {
  decimalUsdSchema as decimalUsd,
  budgetUsageSchema as usageSchema,
  budgetPricesSchema as pricesSchema,
  cumulativeUsageSchema as cumulativeSchema,
  budgetLimitsSchema as limitsSchema,
} from '@cert-board/shared';

export function usdToNano(value: string): bigint {
  const [whole, fraction = ''] = decimalUsd.parse(value).split('.');
  return BigInt(whole!) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
}

export function nanoToUsd(value: bigint): string {
  if (value < 0n) throw new Error('费用不能为负数。');
  const whole = value / 1_000_000_000n;
  const fraction = (value % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** inputTokens采用上游prompt_tokens口径，包含cacheReadTokens。每部分向上取整，避免漏算极小费用。 */
export function estimateCostNano(
  rawUsage: z.input<typeof usageSchema>,
  rawPrices: z.input<typeof pricesSchema>,
): bigint {
  const usage = usageSchema.parse(rawUsage),
    prices = pricesSchema.parse(rawPrices);
  const price = (tokens: number, amount: string) =>
    (BigInt(tokens) * usdToNano(amount) + 999_999n) / 1_000_000n;
  return (
    price(usage.inputTokens - usage.cacheReadTokens, prices.inputUsdPerMillion) +
    price(usage.cacheReadTokens, prices.cacheReadUsdPerMillion) +
    price(usage.outputTokens, prices.outputUsdPerMillion)
  );
}

export function pickBeijingMonth(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error('计量时间无效。');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(value);
  return `${parts.find((p) => p.type === 'year')!.value}-${parts.find((p) => p.type === 'month')!.value}`;
}

/** 每轮直接比较Pi报告的累计值，不保存上一轮状态、不把累计快照重复相加。 */
export function evaluateCumulativeBudget(
  rawUsage: z.input<typeof cumulativeSchema>,
  rawLimits: z.input<typeof limitsSchema>,
): { stop: boolean; reason: 'metering_incomplete' | 'steps' | 'tokens' | 'cost' | null } {
  const usage = cumulativeSchema.parse(rawUsage),
    limits = limitsSchema.parse(rawLimits);
  if (usage.costNano === null) return { stop: true, reason: 'metering_incomplete' };
  if (usage.steps >= limits.maxSteps) return { stop: true, reason: 'steps' };
  if (usage.totalTokens >= limits.maxTokens) return { stop: true, reason: 'tokens' };
  if (BigInt(usage.costNano) >= BigInt(limits.maxCostNano)) return { stop: true, reason: 'cost' };
  return { stop: false, reason: null };
}
