import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { t1PageSchema } from '@cert-board/shared';
import { normalizeWhitespace, quoteAppears } from './quotes.js';

describe('V1只统一空白，不改写原文', () => {
  it('换行、制表和连续空白可以统一，空引用不能通过', () => {
    expect(quoteAppears('A\n\t510(k)   Number:\u00a0K170825\nB', '510(k) Number: K170825')).toBe(
      true,
    );
    expect(quoteAppears('实际文字', '  \n\t')).toBe(false);
    expect(quoteAppears('', '')).toBe(false);
    expect(normalizeWhitespace(' A\r\n B ')).toBe('A B');
  });
  it('大小写、数字和Unicode写法保持逐字要求', () => {
    expect(quoteAppears('510(k) Number: K170825', '510(K) Number: K170825')).toBe(false);
    expect(quoteAppears('510(k) Number: K170825', '510(k) Number: K170285')).toBe(false);
    expect(quoteAppears('é', 'e\u0301')).toBe(false);
    expect(quoteAppears('K170825', 'Ｋ170825')).toBe(false);
  });
  it('L08 T1真实两处摘录通过，改一个字符和换错页被拒绝', () => {
    const pages = readFileSync(
      new URL('../../../../fixtures/l08/t1_out/pages.jsonl', import.meta.url),
      'utf8',
    )
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => t1PageSchema.parse(JSON.parse(line)));
    const first = pages.find((page) => page.doc === 'D035' && page.page === 1)!;
    const fifth = pages.find((page) => page.doc === 'D035' && page.page === 5)!;
    expect(Boolean(first && fifth)).toBe(true);
    expect(quoteAppears(first.text, '510(k) Number: K170825')).toBe(true);
    expect(quoteAppears(fifth.text, '510(K) number K170285')).toBe(true);
    expect(quoteAppears(first.text, '510(k) Number: K170826')).toBe(false);
    expect(quoteAppears(first.text, '510(K) number K170285')).toBe(false);
  });
});
