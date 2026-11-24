import { createHash } from 'node:crypto';
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
  expect(() =>
    summarize(report, {
      ...proof,
      verification: {
        channels: [
          { ...proof.verification.channels[0], status: 'unknown' },
          proof.verification.channels[1],
        ],
      },
    }),
  ).toThrow();
});

test('Cursor 真实回执只接受相符的通道、两种模型并如实保留待核账', () => {
  const cursor = {
    ...proof,
    modelTransport: 'cursor-acp',
    mainModel: 'cursor/gpt-5.6-sol',
    verification: {
      gatewayTransport: 'cursor-acp',
      channels: [
        proof.verification.channels[0],
        { ...proof.verification.channels[1], status: 'unknown' },
      ],
    },
    cost: [
      { model: 'cursor/gpt-5.6-sol', calls: 4, unknown: 4, usd: '0' },
      { model: 'cursor/claude-opus-5.5', calls: 1, unknown: 1, usd: '0' },
    ],
  };
  expect(summarize(report, cursor)).toMatchObject({
    primaryModel: 'cursor/gpt-5.6-sol',
    modelTransport: 'cursor-acp',
    unsettledRequests: 5,
    settledUsd: '0',
  });
  expect(() => summarize(report, { ...cursor, mainModel: 'openai/gpt-6.2-astra-pro' })).toThrow();
  expect(() => summarize(report, { ...cursor, cost: proof.cost })).toThrow();
  expect(() =>
    summarize(report, {
      ...cursor,
      verification: { ...cursor.verification, channels: proof.verification.channels },
    }),
  ).toThrow();
  expect(() =>
    summarize(report, {
      ...cursor,
      cost: [cursor.cost[0], { ...cursor.cost[1], unknown: 0 }],
    }),
  ).toThrow();
  expect(() =>
    summarize(report, { ...cursor, cost: [{ ...cursor.cost[0], unknown: 0 }, cursor.cost[1]] }),
  ).toThrow();
  expect(() =>
    summarize(report, { ...cursor, cost: [{ ...cursor.cost[0], unknown: 2 }, cursor.cost[1]] }),
  ).toThrow();
  expect(
    summarize(report, {
      ...cursor,
      cost: [{ ...cursor.cost[0], unknown: 2, notSent: 2 }, cursor.cost[1]],
    }),
  ).toMatchObject({ requests: 5, unsettledRequests: 3 });
});

test('只接受虚拟机走查步骤记录的那轮回执', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cert-board-baseline-'));
  try {
    const receipt = JSON.stringify(proof);
    const resultSha256 = createHash('sha256').update(receipt).digest('hex');
    const logRecord = (folder: string) => `标准走查回执 ${folder} ${resultSha256}\n`;
    const officialFolder = '2026-11-23T11-15-00-000Z';
    const copyRun = (preview: string, folder: string, completedAt: Date) => {
      const dir = path.join(preview, 'evidence', folder);
      mkdirSync(dir, { recursive: true });
      const resultPath = path.join(dir, 'result.json');
      const receiptPath = path.join(dir, 'receipt.json');
      writeFileSync(resultPath, receipt);
      utimesSync(resultPath, completedAt, completedAt);
      const writeReceipt = (omitDigest = false) => {
        writeFileSync(
          receiptPath,
          JSON.stringify({
            status: 'passed',
            commit,
            evidence: dir,
            ...(omitDigest ? {} : { resultSha256 }),
          }),
        );
        const issuedAt = new Date(+completedAt + 1000);
        utimesSync(receiptPath, issuedAt, issuedAt);
      };
      writeReceipt();
      return { dir, resultPath, writeReceipt };
    };
    const writeEvidence = (name: string) => {
      const vm = path.join(root, name);
      const preview = path.join(vm, 'source', '.local', 'preview');
      const run = copyRun(preview, officialFolder, new Date(recorded.completedAt));
      const reportPath = path.join(vm, 'report.json');
      const logPath = path.join(vm, 'walkthrough.log');
      writeFileSync(reportPath, JSON.stringify(report));
      writeFileSync(logPath, logRecord(officialFolder));
      return { reportPath, logPath, preview, ...run };
    };
    const first = writeEvidence('first');
    const other = writeEvidence('other');
    expect(readBaselineFiles(first.reportPath, first.resultPath).testCommit).toBe(commit);
    expect(() => readBaselineFiles(first.reportPath, other.resultPath)).toThrow();
    const alternativeFolder = '2026-11-23T11-15-01-000Z';
    const alternative = copyRun(first.preview, alternativeFolder, new Date(recorded.completedAt));
    expect(() => readBaselineFiles(first.reportPath, alternative.resultPath)).toThrow(
      '没有找到本次虚拟机走查步骤记录的回执',
    );
    writeFileSync(first.logPath, logRecord(officialFolder) + logRecord(alternativeFolder));
    expect(() => readBaselineFiles(first.reportPath, first.resultPath)).toThrow();
    writeFileSync(first.logPath, logRecord(officialFolder));
    first.writeReceipt(true);
    expect(() => readBaselineFiles(first.reportPath, first.resultPath)).toThrow();
    first.writeReceipt();
    writeFileSync(first.resultPath, receipt + '\n');
    utimesSync(first.resultPath, new Date(recorded.completedAt), new Date(recorded.completedAt));
    expect(() => readBaselineFiles(first.reportPath, first.resultPath)).toThrow();
    writeFileSync(first.resultPath, receipt);
    const later = new Date('2026-11-23T11:17:00.000Z');
    utimesSync(first.resultPath, later, later);
    expect(() => readBaselineFiles(first.reportPath, first.resultPath)).toThrow();
    utimesSync(first.resultPath, new Date(recorded.completedAt), new Date(recorded.completedAt));
    const laterRun = copyRun(first.preview, '2026-11-23T11-17-00-000Z', later);
    const latest = JSON.stringify({
      status: 'passed',
      commit,
      evidence: laterRun.dir,
      resultSha256,
    });
    writeFileSync(path.join(first.preview, 'walkthrough.json'), latest);
    expect(() => readBaselineFiles(first.reportPath, laterRun.resultPath)).toThrow();
    expect(readBaselineFiles(first.reportPath, first.resultPath).testCommit).toBe(commit);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
