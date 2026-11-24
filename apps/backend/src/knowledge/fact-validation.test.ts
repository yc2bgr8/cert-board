import { expect, test } from 'vitest';
import { factDecisionInputSchema, factProposalSchema } from '@cert-board/shared';

test('数值事实须带明确单位，处理时间须用有效时区偏移', () => {
  const proposal = {
    subject: '合成对象',
    field: 'diameter',
    value: 10,
    evidence: {
      documentId: '10000000-0000-4000-8000-000000000001',
      version: 1,
      page: 1,
      quote: '合成尺寸 10 mm',
    },
  };
  expect(factProposalSchema.safeParse(proposal).success).toBe(false);
  expect(factProposalSchema.safeParse({ ...proposal, unit: 'mm' }).success).toBe(true);
  expect(factProposalSchema.safeParse({ ...proposal, unit: '无量纲' }).success).toBe(true);
  const rewrite = { decision: 'rewrite', expectedVersion: 1, value: 10, reason: '按合成原件改写' };
  expect(factDecisionInputSchema.safeParse(rewrite).success).toBe(false);
  expect(factDecisionInputSchema.safeParse({ ...rewrite, unit: 'mm' }).success).toBe(true);
  const due = { decision: 'set_due', expectedVersion: 1, dueAt: '2030-01-01T08:00:00+16:00' };
  expect(factDecisionInputSchema.safeParse(due).success).toBe(false);
  expect(
    factDecisionInputSchema.safeParse({ ...due, dueAt: '2030-01-01T08:00:00+14:00' }).success,
  ).toBe(true);
});
