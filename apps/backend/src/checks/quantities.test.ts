import { expect, test } from 'vitest';
import type { StructuredSubmission } from '@cert-board/shared';
import { checkQuantityClaim as checkWithSource } from './quantities.js';

const checkQuantityClaim = (claim: StructuredSubmission['claims'][number]) =>
  checkWithSource(claim, ({ quote }) => quote);

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

test('V7 识别两端带单位的完整区间，拒绝端点、数值尾段和复合单位前缀', () => {
  expect(checkQuantityClaim(claim('20–25', '℃', '允许范围 20°C–25°C。'))).toBeNull();
  expect(checkQuantityClaim(claim(25, '℃', '允许范围 20°C–25°C。'))).toBe('quantity_mismatch');
  expect(checkQuantityClaim(claim('5–10', 'mm', '尺寸范围 5 mm 至 1 cm。'))).toBeNull();
  expect(checkQuantityClaim(claim(1200, 'mm', '长度为 1,200 mm。'))).toBeNull();
  expect(checkQuantityClaim(claim(200, 'mm', '长度为 1,200 mm。'))).toBe('quantity_mismatch');
  expect(checkQuantityClaim(claim(5, 'cm', '面积为 5 cm²。'))).toBe('quantity_mismatch');
  expect(checkQuantityClaim(claim(5, 'kg', '变化率为 5 kg / h。'))).toBe('quantity_mismatch');
  expect(checkQuantityClaim(claim('5–10', 'g', 'Dose: 5 g–10 g / 100 mL.'))).toBe(
    'quantity_mismatch',
  );
  expect(checkQuantityClaim(claim(5, 'g', 'Dose: 5g–10g / 100 mL.'))).toBe('quantity_mismatch');
  expect(checkQuantityClaim(claim(5, 'g', 'Dose: 5 g * 100 mL.'))).toBe('quantity_mismatch');
  expect(checkQuantityClaim(claim(5, 'g', 'Dose: 5 g * (100 mL).'))).toBe('quantity_mismatch');
  expect(checkQuantityClaim(claim(100, 'mL', 'Dose: 5 g * (100 mL).'))).toBe('quantity_mismatch');
  expect(checkQuantityClaim(claim(5, 'g', 'Dose: 5 g *\n* Follow label.'))).toBeNull();
  expect(checkQuantityClaim(claim(5, 'cm', '气道压力为 5 cm H₂O。'))).toBe('quantity_mismatch');
});

test('V7 核对单位和整个范围，不从不相干单位或一个端点推断', () => {
  expect(checkQuantityClaim(claim('−10 至 -5', '℃', '储存温度 −10 to -5°C。'))).toBeNull();
  expect(
    checkQuantityClaim(claim('4–20', 'cmH₂O', '治疗压力范围 4–20 cmH₂O，步进 0.5 cmH₂O。')),
  ).toBeNull();
  expect(checkQuantityClaim(claim(10, 'mm', '尺寸为 1 cm。'))).toBeNull();
  expect(checkQuantityClaim(claim(5, 'g', 'Add 5 g to 10 mL of water.'))).toBeNull();
  expect(checkQuantityClaim(claim(10, 'mL', 'Add 5 g to 10 mL of water.'))).toBeNull();
  expect(checkQuantityClaim(claim(5, 'g', 'Add exactly 5 g to 10 mL of water.'))).toBeNull();
  expect(checkQuantityClaim(claim(5, 'kg', 'Allowed range: 5 kg to 10 cm.'))).toBe(
    'quantity_mismatch',
  );
  expect(checkQuantityClaim(claim(10, 'mm', '试验持续 10 秒。'))).toBe('quantity_mismatch');
  expect(checkQuantityClaim(claim(20, '℃', '允许范围 20–25℃。'))).toBe('quantity_mismatch');
  expect(checkQuantityClaim(claim(-5, '℃', '温度−5℃。'))).toBeNull();
  expect(checkQuantityClaim(claim(5, '℃', '温度−5℃。'))).toBe('quantity_mismatch');
  expect(checkQuantityClaim(claim(4, '未知单位', '测试值为 4。'))).toBe('quantity_format');
});

test('V7 回查完整来源页，拒绝原文截取的端点、算式因子及不同大小写的单位', () => {
  expect(checkWithSource(claim(25, '℃', '25℃'), () => '允许范围 20–\n25℃。')).toBe(
    'quantity_mismatch',
  );
  expect(checkWithSource(claim('20–25', '℃', '20– 25℃'), () => '允许范围 20–\n25℃。')).toBeNull();
  expect(checkWithSource(claim(25, '℃', '25℃'), () => '目标 25℃。另一个范围是 20–25℃。')).toBe(
    'quantity_mismatch',
  );
  expect(checkWithSource(claim(2, 'cm', '2 cm'), () => '宽度 1/2 cm。')).toBe('quantity_mismatch');
  expect(checkQuantityClaim(claim(10, 'cm', '面积 5×10 cm。'))).toBe('quantity_mismatch');
  expect(checkQuantityClaim(claim(5, 's', '导纳 5 S。'))).toBe('quantity_mismatch');
  expect(checkQuantityClaim(claim(1, 'mm', '长度 1 Mm。'))).toBe('quantity_mismatch');
  expect(checkQuantityClaim(claim(5, 'V', '电压 5 V。'))).toBeNull();
  expect(checkWithSource(claim(10, 'V', '10 V'), () => '输出为 10 V / .5。')).toBe(
    'quantity_mismatch',
  );
  expect(
    checkWithSource(claim(25, '℃', '25 °C'), () => 'Date: 2026/11/24\nStorage temperature: 25 °C.'),
  ).toBeNull();
  expect(checkQuantityClaim(claim(30, 'Days', 'Shelf life: 30 DAYS.'))).toBeNull();
  expect(checkQuantityClaim(claim(10, 'cm', 'Area: 5 x 10 cm.'))).toBe('quantity_mismatch');
  expect(checkWithSource(claim(10, 'V', '10 V'), () => '输出为 10 V / [5]。')).toBe(
    'quantity_mismatch',
  );
  expect(checkWithSource(claim(10, 'V', '10 V'), () => '温度系数为 10 V/°C。')).toBe(
    'quantity_mismatch',
  );
  expect(checkWithSource(claim(10, 'V', '10 V'), () => '功率为 10 V *\nA。')).toBe(
    'quantity_mismatch',
  );
  expect(checkWithSource(claim(10, 'V', '10 V'), () => '输出电压为 10 V*。')).toBeNull();
  expect(
    checkWithSource(claim(10, 'V', '10 V'), () => '输出电压 10 V\n* 测量应在室温进行。'),
  ).toBeNull();
  expect(
    checkWithSource(claim(25, '℃', '25 °C'), () => 'Date: 24/11/2026\nPage 29\n25 °C.'),
  ).toBeNull();
});
