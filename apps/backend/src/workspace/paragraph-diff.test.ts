import { expect, test } from 'vitest';
import { compareHumanRevision } from './paragraph-diff.js';

test('截断 JSON 转义后会超出历史存储上限的段落摘要', () => {
  const escaped = '\u001b'.repeat(1800);
  const original = Array.from({ length: 65 }, (_entry, index) => `旧${index}${escaped}`).join(
    '\n\n',
  );
  const revised = Array.from({ length: 65 }, (_entry, index) => `新${index}${escaped}`).join(
    '\n\n',
  );
  const result = compareHumanRevision(original, revised);
  expect(result).toMatchObject({ added: 65, removed: 65, truncated: true });
  expect(result.paragraphs.length).toBeGreaterThan(0);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(510 * 1024);
});

test('段落比较保留原文位置并忽略不同换行方式', () => {
  expect(compareHumanRevision('范围\r\n\r\n旧结论\r\n\r\n原文', '范围\n\n新结论\n\n原文')).toEqual({
    added: 1,
    removed: 1,
    truncated: false,
    paragraphs: [
      { kind: 'removed', number: 2, text: '旧结论', truncated: false },
      { kind: 'added', number: 2, text: '新结论', truncated: false },
    ],
  });
});

test('大量细节有显示上限但总数保持准确', () => {
  const changed = Array.from({ length: 90 }, (_, index) => `合成段落 ${index}`).join('\n\n');
  const result = compareHumanRevision('旧版', changed);
  expect(result).toMatchObject({ added: 90, removed: 1, truncated: true });
  expect(result.paragraphs).toHaveLength(80);
});

test('保留会改变 Markdown 呈现的段首缩进和行尾空白', () => {
  const result = compareHumanRevision('    合成文本  ', '合成文本');
  expect(result.paragraphs).toEqual([
    { kind: 'removed', number: 1, text: '    合成文本  ', truncated: false },
    { kind: 'added', number: 1, text: '合成文本', truncated: false },
  ]);
});
