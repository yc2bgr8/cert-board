import { expect, test } from 'vitest';
import {
  expectedR09Revision,
  r09ReadOnlyAnswerMatches,
  r09Replacements,
} from './r09-walkthrough.js';

test('两条修改期望保留其余原文，拒绝没有唯一匹配的初稿', () => {
  const original = [
    '# 核查结果',
    r09Replacements[0][0],
    '实际引用应保留',
    r09Replacements[1][0],
    '',
  ];
  expect(expectedR09Revision(original.join('\r\n'))).toBe(
    ['# 核查结果', r09Replacements[0][1], '实际引用应保留', r09Replacements[1][1], ''].join('\n'),
  );
  expect(() => expectedR09Revision(original.concat(r09Replacements[0][0]).join('\n'))).toThrow();
});

test('只读走查要求最终答复包含逐字原文、各自用途与 MSDS 缺口', () => {
  const pages = [
    { sourceKey: 'D021', page: 29, text: 'Rinse at 20-25 °C.' },
    { sourceKey: 'D023', page: 17, text: 'Cool in water at 20-30 °C.' },
  ];
  const msds = { sourceKey: 'D099', page: 2 };
  const answer = {
    用水证据: [
      { 资料编号: 'D021', 页码: 29, 用途: '冲洗', 原文: pages[0]!.text },
      { 资料编号: 'D023', 页码: 17, 用途: '冷却', 原文: pages[1]!.text },
    ],
    MSDS: { 资料编号: 'D099', 页码: 2, 状态: '待核证据', 缺失: '第二处独立证据' },
  };
  const matches = (text: string) => r09ReadOnlyAnswerMatches(text, pages, msds);
  const text = JSON.stringify(answer);
  expect(matches(text)).toBe(true);
  expect(matches(`\u0060\u0060\u0060json\n${text}\n\u0060\u0060\u0060`)).toBe(true);
  expect(matches('水温不同用途，MSDS 待核证据。')).toBe(false);
  expect(matches(text.replace('Cool in water', 'Cool in solution'))).toBe(false);
  expect(matches(text.replace('冲洗', '非冲洗'))).toBe(false);
  expect(matches(text.replace(' °C.', ''))).toBe(false);
  expect(matches(text.replace('D099', 'D098'))).toBe(false);
  expect(matches(text.replace('第二处独立证据', '实际附件'))).toBe(true);
  expect(matches(text.replace('第二处独立证据', '无缺件'))).toBe(false);
  expect(matches(text.replace('第二处独立证据', '无. 附件和独立证据均齐备'))).toBe(false);
  expect(matches(text.replace('待核证据', '已证实差异'))).toBe(false);
});
