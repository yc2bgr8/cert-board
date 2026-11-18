import { expect, test } from 'vitest';
import {
  toolApprovalDecisionInputSchema,
  toolApprovalPreviewSchema,
  toolApprovalViewSchema,
} from './approvals.js';
const id = '00000000-0000-4000-8000-000000000001';
const preview = {
  summary: '更新下一步记录',
  changes: [
    {
      recordType: 'cert_project',
      recordId: id,
      field: 'nextAction',
      before: null,
      after: '待核对',
    },
  ],
  targetVersions: [{ targetType: 'cert_project', targetId: id, version: 1 }],
  dataLevel: 'internal',
};
test('批准预览包含具体前后值并将版本规范为字符串', () => {
  expect(toolApprovalPreviewSchema.parse(preview).targetVersions[0]?.version).toBe('1');
  expect(toolApprovalPreviewSchema.safeParse({ ...preview, changes: [] }).success).toBe(false);
});
test('批准预览拒绝未知字段、无效字符和过大正文', () => {
  expect(toolApprovalPreviewSchema.safeParse({ ...preview, secret: 'fixture' }).success).toBe(
    false,
  );
  expect(toolApprovalPreviewSchema.safeParse({ ...preview, summary: '\ud800' }).success).toBe(
    false,
  );
  expect(
    toolApprovalPreviewSchema.safeParse({
      ...preview,
      changes: [{ ...preview.changes[0], after: '中'.repeat(24000) }],
    }).success,
  ).toBe(false);
});
test('浏览器决定只接受版本、哈希、决定与拒绝原因，不接受执行参数或身份', () => {
  const decision = {
    requestKey: id,
    expectedVersion: 1,
    expectedContentHash: 'a'.repeat(64),
    action: 'allow_once',
  };
  expect(toolApprovalDecisionInputSchema.safeParse(decision).success).toBe(true);
  for (const extra of [{ arguments: { value: '替换' } }, { approvedBy: id }, { role: 'ADMIN' }])
    expect(toolApprovalDecisionInputSchema.safeParse({ ...decision, ...extra }).success).toBe(
      false,
    );
  expect(
    toolApprovalDecisionInputSchema.safeParse({ ...decision, reason: '隐藏原因' }).success,
  ).toBe(false);
  expect(
    toolApprovalDecisionInputSchema.safeParse({ ...decision, action: 'reject', reason: '请先核对' })
      .success,
  ).toBe(true);
});
test('批准卡DTO不能夹带原始参数', () => {
  const result = toolApprovalViewSchema.safeParse({
    id,
    conversationId: id,
    runId: id,
    toolName: 'write_record',
    toolVersion: '1',
    version: 1,
    contentHash: 'a'.repeat(64),
    status: 'pending',
    preview: { summary: preview.summary, changes: preview.changes },
    dataLevel: 'internal',
    createdAt: '2026-11-18T00:00:00Z',
    decidedAt: null,
    argumentsJson: { private: '正文' },
  });
  expect(result.success).toBe(false);
});
