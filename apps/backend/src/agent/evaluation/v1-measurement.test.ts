import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { measureV1 } from './v1-measurement.js';

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../../fixtures/v1/measurement-synthetic.json', import.meta.url),
    'utf8',
  ),
);
const find = (report: ReturnType<typeof measureV1>, code: string) =>
  report.metrics.find((item) => item.code === code);

test('合成样例核对全部口径，百分之九十的分位数按最近秩处理', () => {
  const report = measureV1(fixture);
  expect(report).toMatchObject({ scope: 'synthetic', status: 'measured', severeFindings: [] });
  expect(report.metrics).toHaveLength(21);
  expect(find(report, 'r09_known_count')).toMatchObject({ value: 7, total: 8, status: 'pass' });
  expect(find(report, 'system_first_work_p90')).toMatchObject({
    value: 5000,
    total: 10,
    status: 'pass',
  });
  expect(find(report, 'system_ui_action_p90')).toMatchObject({
    value: 1000,
    total: 10,
    status: 'pass',
  });
  expect(find(report, 'system_non_model_failures')).toMatchObject({ value: 0.02, status: 'pass' });
  expect(find(report, 'staff_weekly_use_baseline')).toMatchObject({ value: 3, status: 'baseline' });
});

test('没有证据、零样本及缺少人员确认均保持待测', () => {
  const empty = measureV1({ ...fixture, scope: 'offline-development', observations: {} });
  expect(empty.status).toBe('awaiting_evidence');
  expect(
    empty.metrics.every((metric) => metric.status === 'pending' && metric.value === null),
  ).toBe(true);
  const changed = structuredClone(fixture);
  changed.observations.r09Injected.data = { matched: 0, total: 0 };
  changed.observations.m01Import.data.staffSampleConfirmed = false;
  delete changed.observations.safetyChecks.data.model_gateway;
  const pending = measureV1(changed);
  for (const code of ['r09_injected', 'm01_import', 'safety_checks'])
    expect(find(pending, code)?.status).toBe('pending');
});

test('严重问题、误认公开数据、较慢过程和错误的台账回复阻塞判分', () => {
  const input = structuredClone(fixture);
  input.observations.severeReview.data = ['fabrication'];
  input.observations.m02Public.data.brands = 'claimed_confirmed';
  input.observations.firstWorkMs.data = [5001, 5100];
  input.observations.ledger.data.matches.market_status = 'fail';
  const report = measureV1(input);
  expect(report.status).toBe('blocked');
  expect(report.severeFindings).toEqual(['fabrication', 'mislabelled_unverified']);
  for (const code of ['m02_public', 'system_first_work_p90', 'ledger_templates', 'severe_findings'])
    expect(find(report, code)?.status).toBe('fail');
});

test('样本计数错误、缺出处和无效提交编号拒绝输入', () => {
  const invalid = structuredClone(fixture);
  invalid.observations.s01Trace.data.matched = 5;
  expect(() => measureV1(invalid)).toThrow();
  expect(() => measureV1({ ...fixture, head: 'main' })).toThrow();
  const withoutSource = structuredClone(fixture);
  withoutSource.observations.staffWeeklyUse.evidence = [];
  expect(() => measureV1(withoutSource)).toThrow();
});

test('离线索引拒绝不同合并树或范围的证据，正式输入待独立采集接入', () => {
  const input = {
    ...fixture,
    scope: 'offline-development',
    observations: { r09Known: fixture.observations.r09Known },
  };
  const receipt = {
    id: input.observations.r09Known.evidence[0],
    scope: 'offline-development',
    head: input.head,
    main: input.main,
    tree: input.tree,
  };
  expect(() =>
    measureV1({ ...input, evidenceIndex: [{ ...receipt, scope: 'synthetic' }] }),
  ).toThrow();
  expect(() =>
    measureV1({ ...input, evidenceIndex: [{ ...receipt, tree: input.main }] }),
  ).toThrow();
  expect(find(measureV1({ ...input, evidenceIndex: [receipt] }), 'r09_known_count')?.status).toBe(
    'pass',
  );
  expect(() =>
    measureV1({ ...input, scope: 'formal', evidenceIndex: [{ ...receipt, scope: 'formal' }] }),
  ).toThrow();
});

test('已观测的模板失败不能通过漏列分母隐藏，自动归入确定的严重错误', () => {
  const input = structuredClone(fixture);
  input.observations.ledger.data.enabled = ['due_licenses'];
  input.observations.ledger.data.matches.market_status = 'fail';
  input.observations.m02Public.data.brands = 'claimed_confirmed';
  const report = measureV1(input);
  expect(find(report, 'ledger_templates')).toMatchObject({ status: 'fail', total: 2 });
  expect(find(report, 'severe_findings')).toMatchObject({
    status: 'fail',
    value: 1,
    evidence: ['synthetic-severe-review', 'synthetic-m02'],
  });
  expect(report.severeFindings).toEqual(['mislabelled_unverified']);
});
