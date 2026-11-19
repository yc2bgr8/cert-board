import { describe, expect, it, test } from 'vitest';
import { containsConfidentialOverlap, redactExternalMessages } from './policy.js';

test('完整短保密原文也会拦截', () => {
  expect(
    containsConfidentialOverlap(
      [{ role: 'user', content: '请核对项目别名甲 两点。' }],
      ['项目别名甲'],
    ),
  ).toBe(true);
  expect(
    containsConfidentialOverlap([{ role: 'user', content: '其他内容。' }], ['项目别名甲', '  ']),
  ).toBe(false);
});

describe('外部模型本地内容处理', () => {
  it('按字面匹配最长词和不同大小写，代号只换回对应原文', () => {
    const text = '样例(甲)和样例，Test 产品与 test 产品。';
    const result = redactExternalMessages(
      [{ role: 'user', content: text }],
      ['样例', '样例(甲)', 'test 产品'],
    );
    expect(result.replacementCount).toBe(4);
    expect(result.messages[0]?.content).not.toMatch(/样例|test 产品/iu);
    expect(result.restore(result.messages[0]!.content)).toBe(text);
  });

  it('当前代号如果仍含保密词就拒绝', () => {
    expect(() =>
      redactExternalMessages([{ role: 'user', content: '核对 CB- 编号' }], ['CB-']),
    ).toThrow('替换后仍含保密词');
  });

  it('大小写和空白变化不掩盖保密原文重合片段', () => {
    const source = 'private synthetic agreement detail for catalog';
    expect(
      containsConfidentialOverlap(
        [{ role: 'user', content: '继续核对：PRIVATE   synthetic agreement DETAIL for catalog' }],
        [source],
      ),
    ).toBe(true);
    expect(
      containsConfidentialOverlap([{ role: 'user', content: '核对合同关键词。' }], [source]),
    ).toBe(false);
  });
});
