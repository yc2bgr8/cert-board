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
  const summary = '核对摘要：水温 不同用途，MSDS 待核证据。';
  const answer = [
    '冲洗 D021 第29页：「Rinse at 20-25 °C.」',
    '冷却 D023 第17页：「Cool in water at 20-30 °C.」',
    'MSDS 当前有一处定位，缺第二处独立证据。',
    summary,
  ].join('\n');
  expect(r09ReadOnlyAnswerMatches(answer, pages)).toBe(true);
  expect(r09ReadOnlyAnswerMatches(summary, pages)).toBe(false);
  expect(r09ReadOnlyAnswerMatches(answer.replace('Cool in water', 'Cool in solution'), pages)).toBe(
    false,
  );
  expect(r09ReadOnlyAnswerMatches(answer.replace('缺第二处独立证据', '可以结论'), pages)).toBe(
    false,
  );
});
