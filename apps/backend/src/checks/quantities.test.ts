import { expect, test } from 'vitest';
import type { StructuredSubmission } from '@cert-board/shared';
import { checkQuantityClaim } from './quantities.js';

const claim = (
  value: string | number,
  unit: string,
  quote: string,
): StructuredSubmission['claims'][number] => ({
  id: 'C1',
  object: '合成验证',
  field: '数值',
  value,
  unit,
  quantityCheck: true,
  status: 'checked',
  sources: [{ documentId: '10000000-0000-4000-8000-000000000001', version: 1, page: 1, quote }],
});

test('V7 核对单位和整个范围，不从不相干单位或一个端点推断', () => {
  expect(checkQuantityClaim(claim('−10 至 -5', '℃', '储存温度 −10 to -5°C。'))).toBeNull();
  expect(
    checkQuantityClaim(claim('4–20', 'cmH₂O', '治疗压力范围 4–20 cmH₂O，步进 0.5 cmH₂O。')),
  ).toBeNull();
  expect(checkQuantityClaim(claim(10, 'mm', '尺寸为 1 cm。'))).toBeNull();
  expect(checkQuantityClaim(claim(10, 'mm', '试验持续 10 秒。'))).toBe('quantity_mismatch');
  expect(checkQuantityClaim(claim(20, '℃', '允许范围 20–25℃。'))).toBe('quantity_mismatch');
  expect(checkQuantityClaim(claim(-5, '℃', '温度−5℃。'))).toBeNull();
  expect(checkQuantityClaim(claim(5, '℃', '温度−5℃。'))).toBe('quantity_mismatch');
  expect(checkQuantityClaim(claim(4, '未知单位', '测试值为 4。'))).toBe('quantity_format');
});
