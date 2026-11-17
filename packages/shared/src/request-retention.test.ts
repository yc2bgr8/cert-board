import { expect, test } from 'vitest';
import {
  requestRetentionPolicySchema,
  requestPurgeOptionsSchema,
  syntheticModelRequestSchema,
} from './request-retention.js';

test('默认零保留，期限与清理批量有边界', () => {
  expect(requestRetentionPolicySchema.parse({ environment: 'development' }).retentionDays).toBe(0);
  expect(
    requestRetentionPolicySchema.safeParse({ environment: 'test', retentionDays: -1 }).success,
  ).toBe(false);
  expect(
    requestRetentionPolicySchema.safeParse({ environment: 'test', retentionDays: 31 }).success,
  ).toBe(false);
  expect(requestPurgeOptionsSchema.safeParse({ limit: 1001 }).success).toBe(false);
  expect(requestPurgeOptionsSchema.safeParse({ limit: 0 }).success).toBe(false);
  expect(requestPurgeOptionsSchema.safeParse({ limit: 1, cutoff: '2099-01-01' }).success).toBe(
    false,
  );
});
test('请求正文测试边界排除headers和未标记的真实内容', () => {
  const id = '10000000-0000-4000-8000-000000000001';
  const value = {
    requestId: id,
    runId: id,
    userId: id,
    synthetic: true,
    content: { messages: [{ role: 'user', content: '合成资料' }] },
  };
  expect(syntheticModelRequestSchema.safeParse(value).success).toBe(true);
  expect(syntheticModelRequestSchema.safeParse({ ...value, synthetic: false }).success).toBe(false);
  expect(
    syntheticModelRequestSchema.safeParse({ ...value, content: { ...value.content, headers: {} } })
      .success,
  ).toBe(false);
});
