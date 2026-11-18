import { expect, test } from 'vitest';
import { reviewContentHash } from './content.js';

const content = {
  submission: { conclusion: '待确认', skill: { id: 'R09', version: '0.1.0' } },
  checks: { passed: true },
  diff: { baseVersionId: null, changes: [] },
  evidenceRefs: [{ quote: '原文', readInvocationId: 'fixed-reference' }],
  risk: 'standard',
  cardType: 'finalize',
};
test('审核内容哈希不依赖JSON对象键的序列化次序', () => {
  const reordered = {
    ...content,
    submission: { skill: { version: '0.1.0', id: 'R09' }, conclusion: '待确认' },
  };
  expect(reviewContentHash(reordered)).toBe(reviewContentHash(content));
});
test('结论、检查、风险与读取凭据变化都改变审批所绑定哈希', () => {
  for (const changed of [
    { ...content, submission: { ...content.submission, conclusion: '已确认' } },
    { ...content, checks: { passed: false } },
    { ...content, risk: 'high' },
    { ...content, evidenceRefs: [{ quote: '原文', readInvocationId: 'different-reference' }] },
  ])
    expect(reviewContentHash(changed)).not.toBe(reviewContentHash(content));
});
