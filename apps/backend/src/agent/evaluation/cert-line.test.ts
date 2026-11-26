import { expect, test } from 'vitest';
import { certEvalCases } from '../../../../../evals/cert-line/cases.js';
import { mockOutput, score, validate } from '../../../../../evals/cert-line/score.js';

const cases = certEvalCases();

test('组长认证线保留六个触点各二十例及独立用例编号', () => {
  const counts = new Map<string, number>();
  for (const item of cases) counts.set(item.touchpoint, (counts.get(item.touchpoint) ?? 0) + 1);
  expect(cases).toHaveLength(120);
  expect(new Set(cases.map(({ id }) => id)).size).toBe(120);
  expect(Object.fromEntries(counts)).toEqual({ cx: 20, dx: 20, dr: 20, rg: 20, pd: 20, rp: 20 });
});

test.each(cases)('原剧本满足认证线校验和判分 $id', (item) => {
  expect(validate(item, null).ok).toBe(false);
  const result = validate(item, mockOutput(item));
  expect(result).toMatchObject({ ok: true });
  if (result.ok) expect(score(item, result.value)).toEqual({ pass: true, reason: '' });
});
