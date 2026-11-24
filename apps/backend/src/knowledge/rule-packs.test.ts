import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parseRulePackSeed } from './rule-packs.js';

const seed = readFileSync(
  new URL('../../../../knowledge/us-fda-m02.yaml', import.meta.url),
  'utf8',
);

test('FDA 开发规则包逐条保存相关出处和档案，缺项保留为待确认', () => {
  const pack = parseRulePackSeed(seed);
  expect(pack.rules).toHaveLength(5);
  expect(
    pack.rules.every(
      ({ source, status }) =>
        source.archiveUrl.startsWith('https://') && status === 'pending_confirmation',
    ),
  ).toBe(true);
  expect(
    pack.rules.find(({ id }) => id === 'fiscal_2027_registration_fee')?.parameters,
  ).toMatchObject({
    amount: 13785,
    currency: 'USD',
    fiscal_year: 2027,
    valid_through: '2027-09-30',
  });
  expect(() => parseRulePackSeed(seed.replace('archiveUrl:', 'wrong:'))).toThrow();
  expect(() => parseRulePackSeed(`${seed}\n---\nextra: 1`)).toThrow();
  expect(() => parseRulePackSeed(`code: &tag us_fda_m02\n${seed}`)).toThrow();
});
