import { expect, test } from 'vitest';
import { checkQuestion, decisionFields } from './k14-r02-draft.mjs';

const page = [
  'Re: K260136',
  'Regulation Number:  21 CFR 872.5570',
  'Regulatory Class:  Class II',
  'Product Code:  LRK',
  'We have reviewed your Section 510(k) premarket notification and determined it is substantially equivalent.',
].join('\n');
const record = { id: 'K260136', productCode: 'LRK' };

test('从决定页提取四个审阅答案，产品代码须与档案一致', () => {
  expect(decisionFields(page, record)).toEqual({
    deviceClass: 'II', productCode: 'LRK', regulationNumber: '872.5570', pathway: '510(k)',
  });
  expect(() => decisionFields(page, { ...record, id: 'K260137' })).toThrow('不明确');
  expect(() => decisionFields(page, { ...record, productCode: 'BZD' })).toThrow('不明确');
  expect(() => decisionFields(page.replace('LRK', 'LRK, LQZ'), record)).toThrow('不明确');
  expect(() => decisionFields(page.replace('substantially equivalent', 'under review'), record)).toThrow('不明确');
});

test('匿名题拒绝全角编号、型号别名、产品代码、法规编号及路径答案', () => {
  const hidden = ['Example Co, Ltd.', 'XY-007'];
  expect(() => checkQuestion('美国市场的处方气道压力设备，经面罩送气。', hidden)).not.toThrow();
  for (const text of [
    'Ｋ ２６０１３６', 'Example.Co. Ltd', 'X Y-007', '产品代码 BZD', '868.5905',
    '走５１０（ｋ）路径', '已知属于Ⅱ类',
  ]) expect(() => checkQuestion(text, hidden)).toThrow('遮挡');
});
