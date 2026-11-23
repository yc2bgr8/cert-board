import { expect, test } from 'vitest';
import { expectedR09Revision, r09Replacements } from './r09-walkthrough.js';

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
