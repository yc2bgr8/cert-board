import { afterEach, expect, test, vi } from 'vitest';
import { loadReviewPolicy, parseReviewPolicy, requireReviewPolicy } from './policy.js';

afterEach(() => vi.unstubAllEnvs());
test('固定技能草稿中的检查与证据要求供开发加载', async () => {
  const policy = await loadReviewPolicy('test');
  expect(policy.skill).toEqual({ id: 'R09', version: '0.1.0' });
  expect(policy.requiredChecks).toEqual(['V1', 'V3']);
  expect(policy.minimumEvidence).toBe(2);
  expect(policy.risk).toBe('standard');
  expect(policy.cardType).toBe('finalize');
});
test('生产不能通过显式test选项载入草稿', async () => {
  const policy = await loadReviewPolicy('test');
  vi.stubEnv('NODE_ENV', 'production');
  expect(() => requireReviewPolicy(policy, 'test')).toThrow('开发草稿');
});
test('坏frontmatter、重复键和别名均安全拒绝且不回显原文', () => {
  for (const source of [
    'PRIVATE_SOURCE',
    '---\nprivate: PRIVATE_SECRET\nprivate: value\n---',
    '---\nx: &value PRIVATE_SECRET\ny: *value\n---',
  ]) {
    let message = '';
    try {
      parseReviewPolicy(source, 'test');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.includes('PRIVATE')).toBe(false);
    expect(message).toContain('配置无效');
  }
});
