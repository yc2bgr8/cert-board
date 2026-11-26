import { expect, test } from 'vitest';
import { validateCursorAcceptanceScope } from './cursor-acceptance-scope.js';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const testCommit = 'c'.repeat(40);
const tree = 'd'.repeat(40);
const run = { scope: 'business', status: 'running', testCommit, head, base, mergeTree: tree };
const permit = {
  pr: 'PR-34',
  number: 65,
  head,
  base,
  mergeTree: tree,
  observedHead: 'f'.repeat(40),
};
const current = {
  testCommit,
  parents: `${base} ${head}`,
  tree,
  headSubject: 'PR-34 合成验收提交',
  worktreeStatus: '',
};

test('独立验收只允许标明的 PR 及当前验收提交和合并树', () => {
  expect(validateCursorAcceptanceScope({ pr: 'PR-34', head }, run, permit, current)).toEqual({
    pr: 'PR-34',
    head,
  });
  expect(
    validateCursorAcceptanceScope(
      { pr: 'PR-35', head },
      { ...run, status: 'failed' },
      { ...permit, pr: 'PR-35', number: 66 },
      {
        ...current,
        headSubject: 'PR-35 同树复验',
      },
    ),
  ).toEqual({ pr: 'PR-35', head });
  expect(() =>
    validateCursorAcceptanceScope({ pr: 'PR-36', head }, run, permit, current),
  ).toThrow();
  expect(() =>
    validateCursorAcceptanceScope({ pr: 'PR-34', head }, run, permit, {
      ...current,
      headSubject: 'PR-36 另一项开发',
    }),
  ).toThrow();
  expect(() =>
    validateCursorAcceptanceScope({ pr: 'PR-34', head: 'e'.repeat(40) }, run, permit, current),
  ).toThrow();
  expect(() =>
    validateCursorAcceptanceScope({ pr: 'PR-34', head }, run, permit, {
      ...current,
      parents: head,
    }),
  ).toThrow();
  expect(() =>
    validateCursorAcceptanceScope({ pr: 'PR-34', head }, run, permit, {
      ...current,
      tree: 'e'.repeat(40),
    }),
  ).toThrow();
  expect(() =>
    validateCursorAcceptanceScope(
      { pr: 'PR-34', head },
      { ...run, status: 'passed' },
      permit,
      current,
    ),
  ).toThrow();
  for (const worktreeStatus of [' M apps/backend/src/worker.ts', '?? untracked-source.ts']) {
    expect(() =>
      validateCursorAcceptanceScope({ pr: 'PR-34', head }, run, permit, {
        ...current,
        worktreeStatus,
      }),
    ).toThrow();
  }
});

test('启动参数和匹配标题不能替代独立签发的目标提交记录', () => {
  for (const authorization of [
    null,
    { ...permit, number: 66 },
    { ...permit, head: '1'.repeat(40) },
    { ...permit, base: '1'.repeat(40) },
  ]) {
    expect(() =>
      validateCursorAcceptanceScope({ pr: 'PR-34', head }, run, authorization, current),
    ).toThrow();
  }
});

test('即使双亲正确也须匹配独立签发的合并代码树', () => {
  const otherTree = '1'.repeat(40);
  expect(() =>
    validateCursorAcceptanceScope({ pr: 'PR-34', head }, { ...run, mergeTree: otherTree }, permit, {
      ...current,
      tree: otherTree,
    }),
  ).toThrow();
});
