import { expect, test } from 'vitest';
import { calculateWorkSchedule } from './work-schedule.js';

function step(id: string, durationDays: number, ...dependsOn: string[]) {
  return { id, name: id, owner: '合成负责人', durationDays, dependsOn };
}

const nodes = [
  step('release', 0, 'tests', 'translation'),
  step('sample', 3),
  step('tests', 7, 'sample'),
  step('translation', 4),
];

test('并行节点倒排经过闰日，零日里程碑留在目标日期', () => {
  const result = calculateWorkSchedule({
    targetDate: '2032-03-05',
    earliestStartDate: '2032-02-24',
    nodes,
  });
  expect(result).toMatchObject({
    latestStartDate: '2032-02-24',
    earliestFinishDate: '2032-03-05',
    criticalDays: 10,
    criticalPath: ['sample', 'tests', 'release'],
    feasibility: 'feasible',
    nodes: [
      { id: 'sample', plannedStart: '2032-02-24', plannedFinish: '2032-02-27' },
      { id: 'tests', plannedStart: '2032-02-27', plannedFinish: '2032-03-05' },
      { id: 'translation', plannedStart: '2032-03-01', plannedFinish: '2032-03-05' },
      { id: 'release', plannedStart: '2032-03-05', plannedFinish: '2032-03-05' },
    ],
  });
});

test('明确起始条件时返回可行性，缺失时保留待确认', () => {
  expect(
    calculateWorkSchedule({ targetDate: '2032-03-05', earliestStartDate: '2032-02-25', nodes }),
  ).toMatchObject({
    feasibility: 'start_too_late',
    earliestFinishDate: '2032-03-06',
    latestStartDate: '2032-02-24',
  });
  expect(calculateWorkSchedule({ targetDate: '2032-03-05', nodes })).toMatchObject({
    feasibility: 'start_unconfirmed',
    earliestFinishDate: null,
  });
});

test('缺失、重复与形成环的依赖均被拒绝', () => {
  for (const invalid of [
    [step('a', 1, 'missing')],
    [step('a', 1), step('a', 0)],
    [step('a', 1), step('b', 0, 'a', 'a')],
  ]) {
    expect(() => calculateWorkSchedule({ targetDate: '2032-03-05', nodes: invalid })).toThrow(
      expect.objectContaining({ code: 'WORK_SCHEDULE_DEPENDENCY' }),
    );
  }
  expect(() =>
    calculateWorkSchedule({
      targetDate: '2032-03-05',
      nodes: [step('a', 0, 'b'), step('b', 0, 'a')],
    }),
  ).toThrow(expect.objectContaining({ code: 'WORK_SCHEDULE_CYCLE' }));
});
