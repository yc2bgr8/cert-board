import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { readBaselineFiles, summarizeAgentBaseline } from './baseline.js';

const commit = 'a'.repeat(40);
const report = {
  status: 'passed',
  scope: 'business',
  testCommit: commit,
  base: 'b'.repeat(40),
  head: 'c'.repeat(40),
  mergeTree: 'd'.repeat(40),
  startedAt: '2026-11-23T11:00:00.000Z',
  completedAt: '2026-11-23T11:16:00.000Z',
  steps: [{ name: 'walkthrough', exitCode: 0, seconds: 30 }],
};
const recorded = {
  startedAt: Date.parse('2026-11-23T11:15:00.000Z'),
  completedAt: Date.parse('2026-11-23T11:15:26.000Z'),
};
const summarize = (vm: unknown, result: unknown) => summarizeAgentBaseline(vm, result, recorded);
const reviewed = {
  url: 'http://127.0.0.1:28280/?conversation=31bb6685-0837-4f5e-97af-20b861f1674a',
  tools: ['doc_read', 'skill_load', 'plan_update', 'check_run', 'submit_for_review'],
};
const proof = {
  status: 'passed',
  commit,
  errorId: '02b0d401-3cce-4bbf-a680-5891fec0b72f',
  registration: reviewed,
  maintenance: {
    ...reviewed,
    url: 'http://127.0.0.1:28280/?conversation=69daf4df-712a-483e-9604-70da8229cbd9',
  },
  verification: {
    channels: [
      { channel: 'cursor', model: 'grok-4-7', status: 'settled' },
      { channel: 'gateway', model: 'claude-opus-5-5-gateway', status: 'settled' },
    ],
  },
  cost: [
    { model: 'openai/gpt-6.2-astra-pro', calls: 4, unknown: 1, usd: '0.1' },
    { model: 'anthropic/claude-opus-5.5', calls: 1, unknown: 0, usd: '0.000000001' },
  ],
};

test('基线绑定已验收提交、保留未知用量，输出不含原对话链接和错误编号', () => {
  const baseline = summarize(report, proof);
  expect(baseline).toMatchObject({
    testCommit: commit,
    durationSeconds: 30,
    cases: [
      { id: 'R09', status: 'passed' },
      { id: 'M02', status: 'passed' },
    ],
    unsettledRequests: 1,
    requests: 5,
    settledUsd: '0.100000001',
  });
  expect(JSON.stringify(baseline)).not.toContain(reviewed.url);
  expect(JSON.stringify(baseline)).not.toContain(proof.errorId);
});

test('拒绝旧提交、失败走查、缺模型计量及未齐备的工具或核实双通道', () => {
  expect(() => summarize(report, { ...proof, commit: 'e'.repeat(40) })).toThrow();
  expect(() =>
    summarize({ ...report, steps: [{ ...report.steps[0], exitCode: 1 }] }, proof),
  ).toThrow();
  expect(() => summarize(report, { ...proof, cost: proof.cost.slice(1) })).toThrow();
  expect(() =>
    summarize(report, { ...proof, cost: [{ ...proof.cost[0], calls: 1 }, proof.cost[1]] }),
  ).toThrow();
  expect(() => summarize(report, { ...proof, maintenance: reviewed })).toThrow();
  expect(() =>
    summarize(report, {
      ...proof,
      maintenance: { ...reviewed, url: reviewed.url.replace('31bb6685', '31BB6685') },
    }),
  ).toThrow();
  expect(() =>
    summarize(report, {
      ...proof,
      cost: [proof.cost[0], { ...proof.cost[1], model: 'unverified-label' }],
    }),
  ).toThrow();
  expect(() =>
    summarize(report, {
      ...proof,
      registration: { ...reviewed, tools: ['doc_read'] },
    }),
  ).toThrow();
  expect(() =>
    summarize(report, {
      ...proof,
      verification: { channels: [proof.verification.channels[0], proof.verification.channels[0]] },
    }),
  ).toThrow();
});

test('只接受本次验收目录和有效时间窗中的走查回执', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cert-board-baseline-'));
  try {
    const writeEvidence = (name: string) => {
      const vm = path.join(root, name);
      const dir = path.join(
        vm,
        'source',
        '.local',
        'preview',
        'evidence',
        '2026-11-23T11-15-00-000Z',
      );
      mkdirSync(dir, { recursive: true });
      const reportPath = path.join(vm, 'report.json');
      const resultPath = path.join(dir, 'result.json');
      writeFileSync(reportPath, JSON.stringify(report));
      writeFileSync(resultPath, JSON.stringify(proof));
      utimesSync(resultPath, new Date(recorded.completedAt), new Date(recorded.completedAt));
      return { reportPath, resultPath };
    };
    const first = writeEvidence('first');
    const other = writeEvidence('other');
    expect(readBaselineFiles(first.reportPath, first.resultPath).testCommit).toBe(commit);
    expect(() => readBaselineFiles(first.reportPath, other.resultPath)).toThrow();
    const later = new Date('2026-11-23T11:17:00.000Z');
    utimesSync(first.resultPath, later, later);
    expect(() => readBaselineFiles(first.reportPath, first.resultPath)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
