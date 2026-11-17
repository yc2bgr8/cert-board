import { expect, test } from 'vitest';
import { compareFileManifests, compareTextLines } from './diff.js';
import type { WorkspaceFileDescriptor } from '@cert-board/shared';

const file = (path: string, hash = 'a'): WorkspaceFileDescriptor => ({
  path,
  sha256: hash.repeat(64),
  byteSize: 10,
  dataLevel: 'internal',
  mediaType: 'text/markdown',
});
test('文件对比区分新增修改删除，并识别级别变化', () => {
  const changes = compareFileManifests(
    [file('a.md'), file('b.md'), file('d.md')],
    [file('a.md', 'b'), file('c.md'), { ...file('d.md'), dataLevel: 'confidential' }],
  );
  expect(changes.map(({ path, change }) => ({ path, change }))).toEqual([
    { path: 'a.md', change: 'modified' },
    { path: 'b.md', change: 'deleted' },
    { path: 'c.md', change: 'added' },
    { path: 'd.md', change: 'modified' },
  ]);
  expect(() => compareFileManifests([file('é.md'), file('e\u0301.md')], [])).toThrow('NFC');
});
test('按行对比保留非连续变化、行号与换行，能重建前后原文', () => {
  const before = '首行\r\n旧内容\n中间\n末行';
  const after = '首行\r\n新内容\n中间\n新末行\n';
  const diff = compareTextLines(before, after);
  expect(diff.available).toBe(true);
  expect(
    diff.lines
      .filter((line) => line.kind !== 'added')
      .map((line) => line.text + line.ending)
      .join(''),
  ).toBe(before);
  expect(
    diff.lines
      .filter((line) => line.kind !== 'removed')
      .map((line) => line.text + line.ending)
      .join(''),
  ).toBe(after);
  expect(diff.added).toBe(2);
  expect(diff.removed).toBe(2);
});
test('差异有分页与长行提示，大文件不无限计算', () => {
  const first = compareTextLines('a\nb\nc\n', 'a\nx\nc\n', { limit: 2 });
  expect(first.hasMore).toBe(true);
  const next = compareTextLines('a\nb\nc\n', 'a\nx\nc\n', { offset: first.nextOffset, limit: 2 });
  expect(next.hasMore).toBe(false);
  const long = compareTextLines('', '😀'.repeat(600));
  expect(long.lines[0]?.lineTruncated).toBe(true);
  expect(long.lines[0]?.text).toHaveLength(1000);
  expect(compareTextLines('', 'x'.repeat(1_000_001)).available).toBe(false);
});
