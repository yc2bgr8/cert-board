import { expect, test } from 'vitest';
import { summarizeAgentBaseline } from './baseline.js';

const commit = 'a'.repeat(40);
const report = {
  status: 'passed',
  scope: 'business',
  testCommit: commit,
  base: 'b'.repeat(40),
  head: 'c'.repeat(40),
  mergeTree: 'd'.repeat(40),
  completedAt: '2026-11-23T11:16:00.000Z',
  steps: [{ name: 'walkthrough', exitCode: 0, seconds: 30 }],
};
const reviewed = {
  url: 'http://127.0.0.1:28280/?conversation=31bb6685-0837-4f5e-97af-20b861f1674a',
  tools: ['doc_read', 'skill_load', 'plan_update', 'check_run', 'submit_for_review'],
};
const proof = {
  status: 'passed',
  commit,
  errorId: '02b0d401-3cce-4bbf-a680-5891fec0b72f',
  registration: reviewed,
  maintenance: reviewed,
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
  const baseline = summarizeAgentBaseline(report, proof);
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
  expect(() => summarizeAgentBaseline(report, { ...proof, commit: 'e'.repeat(40) })).toThrow();
  expect(() =>
    summarizeAgentBaseline({ ...report, steps: [{ ...report.steps[0], exitCode: 1 }] }, proof),
  ).toThrow();
  expect(() => summarizeAgentBaseline(report, { ...proof, cost: proof.cost.slice(1) })).toThrow();
  expect(() =>
    summarizeAgentBaseline(report, {
      ...proof,
      registration: { ...reviewed, tools: ['doc_read'] },
    }),
  ).toThrow();
  expect(() =>
    summarizeAgentBaseline(report, {
      ...proof,
      verification: { channels: [proof.verification.channels[0], proof.verification.channels[0]] },
    }),
  ).toThrow();
});
