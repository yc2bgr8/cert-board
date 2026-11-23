import { z } from 'zod';
import type { CxCase } from '../../../../../evals/r09/cx-cases.js';

const extracted = z.strictObject({
  value: z.string().min(1).max(160),
  quote: z.string().min(1).max(600),
});
const extraction = z.strictObject({
  model: extracted,
  pressure_range: extracted,
  software_version: extracted.optional(),
});

export function scoreCxExtraction(example: CxCase, raw: unknown) {
  const result = extraction.safeParse(raw);
  if (!result.success) return { exact: false, quotesValid: false };
  const fields = result.data;
  const quotesValid = Object.values(fields).every(
    (claim) => claim && example.text.includes(claim.quote) && claim.quote.includes(claim.value),
  );
  return {
    exact:
      quotesValid &&
      fields.model.value === example.expected.model &&
      fields.pressure_range.value === example.expected.pressure_range &&
      fields.software_version?.value === example.expected.software_version,
    quotesValid,
  };
}

export const waterUseExample = [
  '塑形完成后，用 20–30℃ 的水冷却器械，随后按要求佩戴。',
  '日常清洁的首次冲洗使用 20–25℃ 的水，冲洗后按说明浸泡。',
] as const;

const waterDecision = z.strictObject({
  sameUse: z.boolean(),
  evidence: z.tuple([z.string().min(1).max(600), z.string().min(1).max(600)]),
});

export function scoreWaterUse(raw: unknown) {
  const result = waterDecision.safeParse(raw);
  if (!result.success || result.data.sameUse) return false;
  return waterUseExample.every((text, index) =>
    result.data.evidence.some(
      (quote) =>
        text.includes(quote) &&
        quote.includes(index === 0 ? '冷却' : '冲洗') &&
        quote.includes(index === 0 ? '20–30' : '20–25'),
    ),
  );
}
