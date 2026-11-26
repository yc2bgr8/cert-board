import { expect, test, vi } from 'vitest';
import type { GatewayResponse } from '@cert-board/shared';
import { certEvalCases } from '../../../../../evals/cert-line/cases.js';
import { mockOutput } from '../../../../../evals/cert-line/score.js';
import {
  certLinePromptHashes,
  evaluateCertLineCase,
  prepareCertLineRequests,
} from './cert-line-run.js';
import { isCertLineAcceptanceJob } from '../../../../../scripts/cert-line-vm.js';
import { validateCertLineScope } from './cert-line-scope.js';
import { compareCertLineReports } from './cert-line-comparison.js';

const cases = certEvalCases();
const requests = await prepareCertLineRequests(cases, 'reference-fixture');

function reply(content: string, costNano: string | null = '1200'): GatewayResponse {
  return {
    requestKey: '00000000-0000-4000-8000-000000000001',
    model: 'reference-fixture',
    upstreamModel: 'fixture/cert-line',
    message: { role: 'assistant', content },
    finishReason: 'stop',
    dataLevel: 'internal',
    usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30, cacheReadTokens: 0, costNano },
  };
}

test('六份参考提示词渲染全部 120 例，保持温度、输出上限和只读请求', async () => {
  expect(requests).toHaveLength(120);
  for (const [index, item] of cases.entries()) {
    const request = requests[index]!;
    expect(request).toMatchObject({
      model: 'reference-fixture',
      tool_choice: 'none',
      temperature: 0.2,
      max_tokens: 4000,
      messages: [{ role: 'system' }, { role: 'user' }],
    });
    expect(request.tools).toBeUndefined();
    expect(JSON.stringify(request.messages)).not.toMatch(/\{\{[a-z_]+\}\}/u);
    expect(
      await evaluateCertLineCase(
        item,
        request,
        async () => reply(JSON.stringify(mockOutput(item))),
        async () => undefined,
      ),
    ).toMatchObject({ id: item.id, valid: true, pass: true, attempts: 1 });
  }
});

test('已计量的 JSON 格式问题可以复试，调用前先保留独立请求编号', async () => {
  const item = cases[0]!;
  const complete = vi
    .fn()
    .mockResolvedValueOnce(reply('无效 JSON'))
    .mockResolvedValueOnce(reply('仍不是 JSON'))
    .mockResolvedValueOnce(reply(JSON.stringify(mockOutput(item))));
  const before = vi.fn(async (_requestKey: string) => undefined);
  const report = await evaluateCertLineCase(item, requests[0]!, complete, before);
  expect(report).toMatchObject({
    pass: true,
    attempts: 3,
    inputTokens: 60,
    outputTokens: 30,
    costUsd: 0.0000036,
  });
  const keys = before.mock.calls.map((call) => call[0]);
  expect(new Set(keys).size).toBe(3);
  for (const [index, key] of keys.entries()) {
    expect(complete.mock.calls[index]![1]).toBe(key);
    expect(before.mock.invocationCallOrder[index]!).toBeLessThan(
      complete.mock.invocationCallOrder[index]!,
    );
  }
});

test('拒绝的请求或未结算的损坏回复不重发，判分失败也无二次请求', async () => {
  const item = cases[0]!;
  const before = vi.fn(async () => undefined);
  const failed = vi.fn(async () => {
    throw Error('transport_failed');
  });
  await expect(evaluateCertLineCase(item, requests[0]!, failed, before)).rejects.toThrow(
    'transport_failed',
  );
  expect(failed).toHaveBeenCalledOnce();
  const unknownCost = vi.fn(async () => reply('无效 JSON', null));
  await expect(
    evaluateCertLineCase(item, requests[0]!, unknownCost, before),
  ).resolves.toMatchObject({
    attempts: 1,
    costUsd: null,
    unpricedAttempts: 1,
    reasonCode: 'invalid_json',
  });
  expect(unknownCost).toHaveBeenCalledOnce();

  const scoreFailure = vi.fn(async () => reply(JSON.stringify({ fields: [] })));
  await expect(
    evaluateCertLineCase(item, requests[0]!, scoreFailure, before),
  ).resolves.toMatchObject({
    valid: true,
    pass: false,
    attempts: 1,
    reasonCode: 'score_failed',
  });
  expect(scoreFailure).toHaveBeenCalledOnce();
});

test('对照只接受完整结束的真实记录，允许已知的脱敏逐例失败原因', () => {
  const report = {
    date: '2026-11-26',
    model: 'fixture/cert-line',
    mock: false,
    results: cases.map(({ id, touchpoint }) => ({
      id,
      touchpoint,
      valid: false,
      pass: false,
      costUsd: null,
      reasonCode: 'validation_failed',
    })),
  };
  expect(() => compareCertLineReports({ ...report, status: 'interrupted' })).toThrow();
  const comparison = compareCertLineReports({ ...report, status: 'completed' });
  expect(comparison.failedCases[0]).toMatchObject({ reasonCode: 'validation_failed' });
  expect(comparison.promptComparability).toBe('unverified');
  const partlyPriced = {
    ...report,
    results: [{ ...report.results[0], settledUsd: '0.000001' }, ...report.results.slice(1)],
  };
  expect(compareCertLineReports(partlyPriced).totals).toMatchObject({
    knownCostUsd: '0.000001',
    unpricedCases: 120,
  });
  const withHashes = { ...report, status: 'completed', promptHashes: certLinePromptHashes };
  expect(compareCertLineReports(withHashes, withHashes).promptComparability).toBe('matched');
  expect(
    compareCertLineReports(withHashes, {
      ...withHashes,
      promptHashes: { ...certLinePromptHashes, cx_fields: 'a'.repeat(64) },
    }).promptComparability,
  ).toBe('mismatch');
});

test('真实命令要求在已通过浏览器检查的 PR-36 验收合并树上运行', () => {
  const base = 'a'.repeat(40),
    head = 'b'.repeat(40),
    mergeTree = 'c'.repeat(40),
    testCommit = 'd'.repeat(40);
  const report = {
    status: 'running',
    scope: 'business',
    base,
    head,
    mergeTree,
    testCommit,
    steps: [
      { name: 'dev-up', exitCode: 0 },
      { name: 'browser', exitCode: 0 },
    ],
  };
  const git = {
    commit: testCommit,
    tree: mergeTree,
    parents: base + ' ' + head,
    subject: 'PR-36 认证评测',
    status: '',
  };
  expect(validateCertLineScope(report, git)).toEqual({ base, head, mergeTree, testCommit });
  const argv = [
    '/usr/bin/node',
    '/home/verifier/acceptance-vm.mjs',
    '--base',
    base,
    '--head=' + head,
    '--acceptance',
    'eval:cert-line:real',
  ];
  expect(isCertLineAcceptanceJob(argv, report)).toBe(true);
  expect(isCertLineAcceptanceJob(argv.slice(0, -1), report)).toBe(false);
  expect(isCertLineAcceptanceJob(argv, { base, head: testCommit })).toBe(false);
  expect(isCertLineAcceptanceJob(['node', 'test-real.mjs', ...argv.slice(2)], report)).toBe(false);
  for (const invalid of [
    { ...git, status: '?? added' },
    { ...git, tree: base },
    { ...git, subject: 'PR-35 评测' },
    { ...git, parents: base },
  ])
    expect(() => validateCertLineScope(report, invalid)).toThrow();
  for (const invalid of [
    { ...report, scope: 'offline-development' },
    { ...report, status: 'failed' },
    { ...report, steps: [{ name: 'dev-up', exitCode: 0 }] },
  ])
    expect(() => validateCertLineScope(invalid, git)).toThrow();
});
