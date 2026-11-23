import { expect, test } from 'vitest';
import { compareIdentifiers, identifierInQuote, normalizeIdentifier } from './identifiers.js';

test('K170285 与官方 K170825 的相邻数字对调列为疑似笔误', () => {
  const observed = normalizeIdentifier('k_number', 'k170285');
  expect(compareIdentifiers('k_number', observed, ['K150364', 'K170825'])).toEqual({
    status: 'possible_typo',
    candidates: [{ identifier: 'K170825', edits: 1 }],
  });
  expect(identifierInQuote('k_number', observed, '写法 K170285/K170825')).toBe(true);
  expect(identifierInQuote('k_number', observed, '写法 BK1702850')).toBe(false);
  expect(identifierInQuote('regulation_number', '872.5570', '法规号 872.5570.1')).toBe(false);
  expect(identifierInQuote('regulation_number', '872.5570', '法规号 872.5570.')).toBe(true);
  expect(identifierInQuote('k_number', 'K170-825', '待核原文 K170-825')).toBe(true);
  expect(
    identifierInQuote('device_identifier', 'SPACE-FILL / 6380407', '型号 SPACE-FILL / 6380407。'),
  ).toBe(true);
  expect(compareIdentifiers('k_number', 'K170-825', ['K170825']).candidates).toEqual([
    { identifier: 'K170825', edits: 1 },
  ]);
});

test('精确匹配优先，两个字符的缺漏或替换仍保留候选', () => {
  expect(compareIdentifiers('k_number', 'K170825', ['K170285', 'K170825'])).toEqual({
    status: 'matched',
    candidates: [],
  });
  expect(compareIdentifiers('k_number', 'K1708', ['K170825'])).toEqual({
    status: 'possible_typo',
    candidates: [{ identifier: 'K170825', edits: 2 }],
  });
  expect(compareIdentifiers('licence_number', '86512', ['95028'])).toEqual({
    status: 'different',
    candidates: [],
  });
  expect(() => compareIdentifiers('k_number', 'K1708', ['ABC'])).toThrow('编号格式');
});
