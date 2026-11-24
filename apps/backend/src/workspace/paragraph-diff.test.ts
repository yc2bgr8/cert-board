import { expect, test } from 'vitest';
import { compareHumanRevision } from './paragraph-diff.js';

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
