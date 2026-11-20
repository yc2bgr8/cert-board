import { expect, test } from 'vitest';
import type { SubagentReport } from '@cert-board/shared';
import { subagentConflicts } from './subagent-conflicts.js';
import { questionForSubagentConflicts } from './subagents.js';

function report(key: string, value: string | number, unit: string | null) {
  const body: SubagentReport = {
    summary: '合成比较',
    missing: [],
    drafts: [],
    claims: [
      {
        id: key,
        object: '合成器械',
        field: '参数',
        value,
        unit,
        status: 'unverified',
        sources: [],
      },
    ],
  };
  return { key, report: body };
}

test('同一单位内等值的数值和十进制文本一致，编号和高精度值保持区别', () => {
  expect(subagentConflicts([report('a', 42, 'g'), report('b', '4.200e1', 'g')])).toEqual([]);
  expect(subagentConflicts([report('a', '00042', null), report('b', '42', null)])).toHaveLength(1);
  expect(
    subagentConflicts([report('a', '9007199254740992', 'g'), report('b', '9007199254740993', 'g')]),
  ).toHaveLength(1);
});

test('单位不一致时提问同时显示两个单位', () => {
  const conflicts = subagentConflicts([report('a', 10, 'g'), report('b', 10, 'mg')]);
  expect(conflicts).toHaveLength(1);
  const question = questionForSubagentConflicts(conflicts).question;
  expect(question).toContain('10 g');
  expect(question).toContain('10 mg');
});
