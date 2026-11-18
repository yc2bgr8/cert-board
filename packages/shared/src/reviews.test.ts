import { describe, expect, it } from 'vitest';
import {
  reviewCardViewSchema,
  reviewDecisionInputSchema,
  reviewDecisionResultSchema,
  reviewEvidenceRefSchema,
  reviewJudgmentInputSchema,
  reviewPolicySchema,
} from './reviews.js';
import { documentCitationSchema } from './checks.js';

const id = '10000000-0000-4000-8000-000000000001';
const now = '2026-11-18T02:00:00.000Z';
const skill = { id: 'R09', version: '0.1.0' };
const citation = { documentId: id, version: 1, page: 1, quote: '虚构 K123456' };
const common = {
  id,
  projectId: id,
  goalId: id,
  conversationId: id,
  workspaceVersion: id,
  skill,
  risk: 'high',
  cardType: 'finalize',
  status: 'pending',
  version: 1,
  createdAt: now,
  decidedAt: null,
};
function visible() {
  return {
    ...common,
    requiresJudgment: false,
    submission: {
      skill,
      workspaceVersion: id,
      conclusion: '需人工核对。',
      claims: [
        {
          id: 'C1',
          object: '示例',
          field: 'K号',
          value: 'K123456',
          unit: null,
          sources: [citation],
          status: 'checked',
        },
      ],
      evidence: [citation],
      missing: [],
      uncertain: [],
      nextStep: '核对原件。',
    },
    checks: {
      passed: true,
      dataLevel: 'internal',
      checks: [
        { code: 'V1', status: 'passed', issues: [] },
        { code: 'V3', status: 'passed', issues: [] },
      ],
      notRun: ['V2', 'V4', 'V5', 'V6', 'V7', 'V8'],
      citations: [],
    },
    diff: { baseVersionId: null, changes: [] },
    evidenceRefs: [{ ...citation, readInvocationId: id }],
    judgment: { statement: '我先独立核对了两处原文。', createdAt: now },
  };
}

describe('审核卡边界契约', () => {
  it('高风险未判断响应只接受安全元数据，不允许携带AI内容或人的决定', () => {
    const locked = { ...common, requiresJudgment: true };
    expect(reviewCardViewSchema.safeParse(locked).success).toBe(true);
    for (const key of ['submission', 'checks', 'diff', 'evidenceRefs', 'judgment', 'decision']) {
      expect(reviewCardViewSchema.safeParse({ ...locked, [key]: null }).success).toBe(false);
    }
    expect(reviewCardViewSchema.safeParse({ ...locked, risk: 'standard' }).success).toBe(false);
  });
  it('高风险完整响应必须含本人判断，刷新后保留退回原因', () => {
    const card = visible();
    expect(reviewCardViewSchema.safeParse(card).success).toBe(true);
    expect(reviewCardViewSchema.safeParse({ ...card, judgment: null }).success).toBe(false);
    const reason = '  请补充第二处引文。\r\n';
    const parsed = reviewCardViewSchema.parse({
      ...card,
      status: 'rejected',
      version: 2,
      decidedAt: now,
      decision: {
        id,
        action: 'rejected',
        reason,
        actorUserId: id,
        createdAt: now,
        snapshotId: null,
      },
    });
    expect(parsed.requiresJudgment).toBe(false);
    if (!parsed.requiresJudgment) expect(parsed.decision?.reason).toBe(reason);
  });
  it('人的原话保持空白和Unicode，退回必须给出原因，不能注入审批身份', () => {
    const statement = '  判断 e\u0301\r\n';
    expect(
      reviewJudgmentInputSchema.parse({ expectedVersion: 1, requestKey: id, statement }).statement,
    ).toBe(statement);
    const input = { expectedVersion: 1, workspaceVersion: id, requestKey: id, action: 'rejected' };
    for (const reason of [undefined, null, ' \n', 'x'.repeat(4001)]) {
      expect(reviewDecisionInputSchema.safeParse({ ...input, reason }).success).toBe(false);
    }
    expect(reviewDecisionInputSchema.parse({ ...input, reason: statement }).reason).toBe(statement);
    expect(
      reviewDecisionInputSchema.safeParse({ ...input, reason: statement, actorUserId: id }).success,
    ).toBe(false);
    expect(reviewDecisionInputSchema.parse({ ...input, action: 'approved' }).reason).toBeNull();
  });
  it('服务端技能要求不能降低检查、证据数或移除开发草稿限制', () => {
    const policy = {
      skill,
      publication: 'draft',
      developmentOnly: true,
      requiredChecks: ['V1', 'V3'],
      minimumEvidence: 2,
      risk: 'standard',
      cardType: 'finalize',
    };
    expect(reviewPolicySchema.safeParse(policy).success).toBe(true);
    for (const changes of [
      { minimumEvidence: 1 },
      { requiredChecks: ['V3'] },
      { developmentOnly: false },
      { publication: 'published' },
    ]) {
      expect(reviewPolicySchema.safeParse({ ...policy, ...changes }).success).toBe(false);
    }
  });
  it('阅读凭据只接受服务端补充字段，模型原始引用不能自报阅读调用', () => {
    const proven = { ...citation, readInvocationId: id };
    expect(reviewEvidenceRefSchema.safeParse(proven).success).toBe(true);
    expect(documentCitationSchema.safeParse(proven).success).toBe(false);
    expect(reviewEvidenceRefSchema.safeParse(citation).success).toBe(false);
  });
  it('批准回执必须有冻结快照，退回回执不能冒称冻结', () => {
    const result = { cardId: id, version: 2, decisionId: id, replayed: false };
    expect(
      reviewDecisionResultSchema.safeParse({ ...result, status: 'approved', snapshotId: id })
        .success,
    ).toBe(true);
    expect(
      reviewDecisionResultSchema.safeParse({ ...result, status: 'approved', snapshotId: null })
        .success,
    ).toBe(false);
    expect(
      reviewDecisionResultSchema.safeParse({ ...result, status: 'rejected', snapshotId: id })
        .success,
    ).toBe(false);
  });
});
