import { expect, test } from 'vitest';
import { proposalContentHash } from './content.js';

test('批准内容按字面绑定，正文/主题/空白改变都不同', () => {
  const content = { subject: '测试主题', body: '原文\n' };
  expect(proposalContentHash(content)).toBe(
    proposalContentHash({ body: '原文\n', subject: '测试主题' }),
  );
  expect(proposalContentHash(content)).not.toBe(proposalContentHash({ ...content, body: '原文' }));
  expect(proposalContentHash(content)).not.toBe(
    proposalContentHash({ ...content, subject: '另一主题' }),
  );
});
