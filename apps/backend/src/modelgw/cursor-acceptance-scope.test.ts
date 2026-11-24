import { expect, test } from 'vitest';
import { validateCursorAcceptanceScope } from './cursor-acceptance-scope.js';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const testCommit = 'c'.repeat(40);
const tree = 'd'.repeat(40);
const run = { scope: 'business', status: 'running', testCommit, head, base, mergeTree: tree };
const current = { testCommit, parents: `${base} ${head}`, tree, headSubject: 'PR-34 合成验收提交' };

test('独立验收只允许标明的 PR 及当前验收提交和合并树', () => {
  expect(validateCursorAcceptanceScope({ pr: 'PR-34', head }, run, current)).toEqual({
    pr: 'PR-34',
    head,
  });
  expect(
    validateCursorAcceptanceScope(
      { pr: 'PR-35', head },
      { ...run, status: 'failed' },
      {
        ...current,
        headSubject: 'PR-35 同树复验',
      },
    ),
  ).toEqual({ pr: 'PR-35', head });
  expect(() => validateCursorAcceptanceScope({ pr: 'PR-36', head }, run, current)).toThrow();
  expect(() =>
    validateCursorAcceptanceScope({ pr: 'PR-34', head }, run, {
      ...current,
      headSubject: 'PR-36 另一项开发',
    }),
  ).toThrow();
  expect(() =>
    validateCursorAcceptanceScope({ pr: 'PR-34', head: 'e'.repeat(40) }, run, current),
  ).toThrow();
  expect(() =>
    validateCursorAcceptanceScope({ pr: 'PR-34', head }, run, { ...current, parents: head }),
  ).toThrow();
  expect(() =>
    validateCursorAcceptanceScope({ pr: 'PR-34', head }, run, { ...current, tree: 'e'.repeat(40) }),
  ).toThrow();
  expect(() =>
    validateCursorAcceptanceScope({ pr: 'PR-34', head }, { ...run, status: 'passed' }, current),
  ).toThrow();
});
