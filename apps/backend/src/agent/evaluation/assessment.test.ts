import { expect, test } from 'vitest';
import { deterministicEvaluationSchema, type StructuredSubmission } from '@cert-board/shared';
import {
  applySemanticReview,
  assessRun,
  assertIndependentReviewModels,
  type EvidenceForEvaluation,
} from './assessment.js';

const citation = {
  documentId: 'd20572fd-72fe-4c86-8a80-59362673fd1c',
  version: 1,
  page: 1,
  quote: '归档到期日 2026-12-31。',
};
const baseSubmission: StructuredSubmission = {
  skill: { id: 'M02', version: '0.1.0' },
  workspaceVersion: 'f6dfed71-4e77-4f45-abe6-462c5c164fab',
  conclusion: '已整理供审核。',
  evidence: [citation],
  missing: [],
  uncertain: [],
  decisions: [],
  nextStep: '人工确认。',
  claims: [
    {
      id: 'deadline',
      object: '合成事项',
      field: 'deadline',
      value: '2026-12-31',
      unit: null,
      status: 'checked',
      sources: [citation],
      deadlineCalculation: {
        startDate: '2026-12-31',
        quantity: 0,
        unit: 'calendar_days',
        jurisdictionTz: 'Asia/Shanghai',
      },
    },
  ],
};
const passed: EvidenceForEvaluation = {
  submission: baseSubmission,
  checks: new Map([
    ['V1', 'passed'],
    ['V3', 'passed'],
    ['V6', 'passed'],
  ]),
  narrativeVerified: true,
  completedEvidenceReads: 1,
  searchesObserved: 1,
  unsettledTools: 0,
  failedTools: 0,
  observedToolPolicies: 4,
  totalExecutedTools: 4,
  readonlyWrites: 0,
  missingApprovals: 0,
  unauthorizedExternalActions: 0,
  usage: 'within_budget',
  progressRecorded: true,
};

test('七维确定性评测输入不变时可重放，未测量用量单独标示', () => {
  const baseline = assessRun(passed);
  expect(deterministicEvaluationSchema.parse(baseline).overall).toBe('passed');
  expect(assessRun(structuredClone(passed))).toEqual(baseline);
  expect(assessRun({ ...passed, usage: 'unmeasured' }).dimensions.efficiency.status).toBe(
    'not_evaluated',
  );
  expect(assessRun({ ...passed, completedEvidenceReads: 0 }).overall).toBe('needs_review');
  expect(assessRun({ ...passed, narrativeVerified: false }).dimensions.answer_quality.status).toBe(
    'needs_review',
  );
});

test('未读资料的断言、未配对工具及无审批副作用分别落到对应维度', () => {
  const submission: StructuredSubmission = {
    ...baseSubmission,
    claims: [
      {
        id: 'absence',
        object: '合成事项',
        field: '附件检索',
        value: '未查到',
        unit: null,
        status: 'checked',
        sources: [],
      },
    ],
  };
  const actual = assessRun({
    ...passed,
    submission,
    searchesObserved: 0,
    unsettledTools: 1,
    readonlyWrites: 1,
    missingApprovals: 1,
    unauthorizedExternalActions: 1,
  });
  expect(actual.dimensions.answer_quality.findings).toEqual(['absence_without_read']);
  expect(actual.dimensions.tool_reliability.findings).toEqual(['tool_unpaired']);
  expect(actual.dimensions.policy.findings).toEqual([
    'readonly_write',
    'approval_missing',
    'external_unauthorized',
  ]);
  expect(actual.overall).toBe('failed');
  expect(assessRun({ ...passed, submission }).dimensions.answer_quality.status).toBe(
    'needs_review',
  );
});

test('语义复核只能降级，不给未知维度补分，同家族拒绝', () => {
  const result = assessRun({ ...passed, readonlyWrites: 1, usage: 'unmeasured' });
  const semantic = applySemanticReview(result, {
    status: 'completed',
    dimensions: { policy: 'passed', answer_quality: 'needs_review', efficiency: 'passed' },
  });
  expect(semantic.dimensions.policy.status).toBe('failed');
  expect(semantic.dimensions.answer_quality.status).toBe('needs_review');
  expect(semantic.dimensions.efficiency.status).toBe('not_evaluated');
  expect(
    applySemanticReview(assessRun(passed), { status: 'unavailable', reason: 'provider_failure' })
      .overall,
  ).toBe('needs_review');
  expect(() => assertIndependentReviewModels({ family: 'qwen' }, { family: 'Qwen' })).toThrow(
    '不同家族',
  );
  expect(() =>
    assertIndependentReviewModels({ family: 'qwen' }, { family: 'anthropic' }),
  ).not.toThrow();
});

test('已核对协作维度也保留未核对答案和依据的待复核状态', () => {
  const review = applySemanticReview(assessRun(passed), {
    status: 'completed',
    dimensions: { collaboration: 'passed' },
  });
  expect(review.dimensions.answer_quality.status).toBe('needs_review');
  expect(review.dimensions.evidence.status).toBe('needs_review');
  expect(review.overall).toBe('needs_review');
});
