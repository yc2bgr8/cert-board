import { expect, test } from 'vitest';
import { cxCases } from '../../../../../evals/r09/cx-cases.js';
import { scoreCxExtraction, scoreWaterUse, waterUseExample } from './r09-extraction.js';

test('组长合成 cx 用例覆盖 20 条、缺软件版本及上一代干扰', () => {
  expect(cxCases).toHaveLength(20);
  expect(new Set(cxCases.map(({ id }) => id)).size).toBe(20);
  expect(cxCases.filter(({ expected }) => !expected.software_version)).toHaveLength(5);
  expect(cxCases.filter(({ text }) => text.includes('上一代型号'))).toHaveLength(7);
  for (const item of cxCases) {
    const prediction = Object.fromEntries(
      Object.entries(item.expected).map(([key, value]) => [
        key,
        { value, quote: item.text.split('\n').find((line) => line.includes(value)) },
      ]),
    );
    expect(scoreCxExtraction(item, prediction)).toEqual({ exact: true, quotesValid: true });
  }
});

test('真实原文里的历史型号参数和虚构引语均不能冒充当前字段', () => {
  const item = cxCases[0]!;
  const answer = {
    model: { value: 'JB-C1', quote: '本文件适用于持续正压通气治疗设备，型号 JB-C1。' },
    pressure_range: {
      value: '4–18 cmH₂O',
      quote: '注：上一代型号 JB-A0 的治疗压力范围为 4–18 cmH₂O，已停产。',
    },
    software_version: { value: 'V1.3.1', quote: '软件版本 V1.3.1。' },
  };
  expect(scoreCxExtraction(item, answer)).toEqual({ exact: false, quotesValid: true });
  expect(
    scoreCxExtraction(item, {
      ...answer,
      software_version: { ...answer.software_version, quote: '当前软件版本为 V1.3.1。' },
    }),
  ).toEqual({ exact: false, quotesValid: false });
});

test('冷却和冲洗复判要求分别引用两种用途的数值原文', () => {
  expect(scoreWaterUse({ sameUse: false, evidence: [...waterUseExample] })).toBe(true);
  expect(scoreWaterUse({ sameUse: true, evidence: [...waterUseExample] })).toBe(false);
  expect(scoreWaterUse({ sameUse: false, evidence: ['20–30℃', '20–25℃'] })).toBe(false);
});
