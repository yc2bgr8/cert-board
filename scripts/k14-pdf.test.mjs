import { expect, test } from 'vitest';
import { indexedPdfPages } from './k14-pdf.mjs';

test('逐页提取核对原件、物理页码并保留空白页', () => {
  const source = { sha256: '4'.repeat(64), bytes: 3000 };
  const pages = [
    { locatorKind: 'physical_page', page: 1, text: '合成 FDA 摘要', method: 'text' },
    { locatorKind: 'physical_page', page: 2, text: '', method: 'ocr' },
  ];
  const result = { sha256: source.sha256, byteSize: source.bytes, kind: 'pdf', pageCount: 2, pages };
  expect(indexedPdfPages(result, source)).toEqual([
    { page: 1, text: '合成 FDA 摘要', method: 'text' }, { page: 2, text: '', method: 'ocr' },
  ]);
  expect(() => indexedPdfPages({ ...result, sha256: '5'.repeat(64) }, source)).toThrow('与原件不符');
  expect(() => indexedPdfPages({ ...result, pageCount: 1 }, source)).toThrow('与原件不符');
  expect(() => indexedPdfPages({ ...result, pages: [pages[0], pages[0]] }, source)).toThrow('页码');
});
