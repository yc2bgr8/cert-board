import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { certEvalCases } from '../../../../../evals/cert-line/cases.js';
import { compareCertLineReports } from './cert-line-comparison.js';

function sample() {
  return {
    date: '2026-11-16',
    model: 'fixture/test',
    mock: false,
    results: certEvalCases().map(({ id, touchpoint }) => ({
      id, touchpoint, valid: true, pass: true, costUsd: null as number | null,
      output: '合成模型正文，只供验证是否泄漏到摘要',
      reason: '合成原始错误，只供验证是否泄漏到摘要',
    })),
  };
}

test('Flash 基线按六类对照，旧逐例文件没有被当作 Flash 基线', async () => {
  const historical = JSON.parse(await readFile(new URL(
    '../../../../../docs/参考/认证线/AI评测/基线-2026-11-16.json',
    import.meta.url,
  ), 'utf8'));
  const result = compareCertLineReports(historical);
  expect(result.candidate.model).toBe('qwen/qwen3-235b-a22b-2507');
  expect(result.baseline).toMatchObject({ level: 'aggregate', model: 'qwen/qwen3.8-flash' });
  expect(result.totals).toMatchObject({ cases: 120, passed: 108, baselinePassed: 116 });
  expect(result.byTouchpoint.find(({ touchpoint }) => touchpoint === 'rg')).toMatchObject({ baselinePassed: 16 });
  expect(result.changes).toBeNull();
  expect(result.failedCases).toHaveLength(12);
});

test('显式逐例基线按用例编号对照并只输出白名单字段', () => {
  const candidate = sample();
  const baseline = sample();
  const first = candidate.results[0]!;
  const second = baseline.results[1]!;
  first.valid = false;
  first.pass = false;
  first.costUsd = 0.02;
  second.pass = false;
  candidate.results.reverse();
  const result = compareCertLineReports(candidate, baseline);
  expect(result.changes).toEqual([
    { id: first.id, touchpoint: first.touchpoint, previous: 'passed', current: 'invalid' },
    { id: second.id, touchpoint: second.touchpoint, previous: 'failed', current: 'passed' },
  ]);
  expect(result.totals).toMatchObject({ knownCostUsd: '0.02', unpricedCases: 119 });
  expect(JSON.stringify(result)).not.toMatch(/合成模型正文|合成原始错误/u);
});

test('拒绝剧本、漏例、重复编号、错配触点和无效达标结果', () => {
  for (const change of [
    (value: ReturnType<typeof sample>) => { value.mock = true; },
    (value: ReturnType<typeof sample>) => { value.results.pop(); },
    (value: ReturnType<typeof sample>) => { value.results[0] = value.results[1]!; },
    (value: ReturnType<typeof sample>) => { value.results[0]!.touchpoint = 'rp'; },
    (value: ReturnType<typeof sample>) => { value.results[0]!.valid = false; },
  ]) {
    const input = sample();
    change(input);
    expect(() => compareCertLineReports(input)).toThrow();
    expect(() => compareCertLineReports(sample(), input)).toThrow();
  }
});
