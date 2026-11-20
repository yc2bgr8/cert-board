import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  bundledBranches,
  originalChecks,
  skippedAcceptance,
  validateAcceptanceScripts,
  validateConfigurationPaths,
  verifyMergeReport,
  verifyRemotePair,
} from './acceptance-vm-policy.mjs';

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const tree = 'c'.repeat(40);

test('轻量标签不会覆盖同 SHA 的分支', () => {
  const entries = bundledBranches(
    `${base} refs/heads/main\n${base} refs/tags/same\n${head} refs/heads/feature`,
  );
  expect(entries.get(base)).toBe('refs/heads/main');
  expect(entries.get(head)).toBe('refs/heads/feature');
});

test('专项只接受已登记脚本，明确跳过的真实测试算失败', () => {
  const scripts = { 'docs:html': 'node scripts/docs-html.mjs' };
  expect(() => validateAcceptanceScripts(['docs:html'], scripts)).not.toThrow();
  expect(() => validateAcceptanceScripts(['install'], scripts)).toThrow('已登记');
  expect(() => validateAcceptanceScripts(['constructor'], scripts)).toThrow('已登记');
  expect(skippedAcceptance('test:real', '跳过真实模型测试：缺少配置。')).toBe(true);
  expect(skippedAcceptance('test:l08', '已跳过 L08 实物对照。')).toBe(true);
  expect(skippedAcceptance('test:real', '通过真实模型回归。')).toBe(false);
});

test('将业务文件重命名到 docs 仍会触发业务验收', async () => {
  const temporary = await realpath(tmpdir());
  const cwd = await mkdtemp(path.join(temporary, 'cert-vm-paths-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    expect(result.status).toBe(0);
    return result.stdout.trim();
  };
  try {
    await mkdir(path.join(cwd, 'apps'));
    await mkdir(path.join(cwd, 'docs'));
    await writeFile(path.join(cwd, 'apps', 'business.txt'), '业务文件\n');
    git('init', '--quiet');
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    );
    await rename(path.join(cwd, 'apps', 'business.txt'), path.join(cwd, 'docs', 'moved.txt'));
    git('add', '-A');
    const deletedAndAdded = git('diff', '--cached', '--name-only', '--no-renames', '-z')
      .split('\0')
      .filter(Boolean);
    expect(deletedAndAdded).toContain('apps/business.txt');
    expect(() => validateConfigurationPaths(deletedAndAdded)).toThrow('配置专项');
  } finally {
    const target = await realpath(cwd);
    if (path.dirname(target) === temporary && path.basename(target).startsWith('cert-vm-paths-'))
      await rm(target, { recursive: true });
  }
});

test('合并要求完整已复审报告，main 或 PR 变化就阻止', () => {
  const report = {
    status: 'passed',
    scope: 'business',
    vm: 'kvm',
    landlockAbi: 8,
    completedAt: '2026-11-20T08:00:00Z',
    base,
    head,
    mergeTree: tree,
    steps: [...originalChecks, 'walkthrough'].map((name) => ({ name, exitCode: 0 })),
  };
  const pr = {
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'main',
    baseRefOid: base,
    headRefOid: head,
  };
  expect(() => verifyMergeReport(report, head)).not.toThrow();
  expect(() => verifyMergeReport(report, tree)).toThrow('完整');
  expect(() => verifyMergeReport({ ...report, steps: report.steps.slice(0, -1) }, head)).toThrow(
    '完整',
  );
  expect(() =>
    verifyMergeReport({ ...report, steps: [...report.steps, { name: 'pr-1', exitCode: 0 }] }, head),
  ).toThrow('完整');
  expect(() => verifyRemotePair(report, pr, base)).not.toThrow();
  expect(() => verifyRemotePair(report, pr, tree)).toThrow('重新验收');
  expect(() => verifyRemotePair(report, { ...pr, headRefOid: tree }, base)).toThrow('重新验收');
});
