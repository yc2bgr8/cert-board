import {
  type DeterministicEvaluation,
  type EvaluationDimensionResult,
  type EvaluationStatus,
  type SemanticEvaluation,
  type StructuredSubmission,
} from '@cert-board/shared';

export const evaluationVersion = '0.1.0';
type Status = EvaluationStatus;
type Finding = EvaluationDimensionResult['findings'][number];
type Dimensions = DeterministicEvaluation['dimensions'];
const statuses: Status[] = ['not_evaluated', 'passed', 'needs_review', 'failed'];
const result = (status: Status, ...findings: Finding[]): EvaluationDimensionResult => ({
  status,
  findings,
});
function combined(dimensions: Dimensions): DeterministicEvaluation {
  const worst =
    statuses[Math.max(...Object.values(dimensions).map(({ status }) => statuses.indexOf(status)))]!;
  const critical = [
    dimensions.task_completion,
    dimensions.answer_quality,
    dimensions.evidence,
    dimensions.policy,
  ];
  return {
    dimensions,
    overall:
      worst === 'passed' && critical.some(({ status }) => status === 'not_evaluated')
        ? 'needs_review'
        : worst,
  };
}

export type EvidenceForEvaluation = {
  submission: StructuredSubmission | null;
  checks: ReadonlyMap<string, 'passed' | 'failed' | 'not_run'>;
  narrativeVerified: boolean;
  completedEvidenceReads: number;
  searchesObserved: number;
  unsettledTools: number;
  failedTools: number;
  observedToolPolicies: number;
  totalExecutedTools: number;
  readonlyWrites: number;
  missingApprovals: number;
  unauthorizedExternalActions: number;
  usage: 'unmeasured' | 'within_budget' | 'over_budget';
  progressRecorded: boolean;
};

export function assessRun(evidence: EvidenceForEvaluation): DeterministicEvaluation {
  const submission = evidence.submission;
  const structuralCheck = evidence.checks.get('V3');
  const sourceCheck = evidence.checks.get('V1');
  const valueFailed =
    evidence.checks.get('V6') === 'failed' || evidence.checks.get('V7') === 'failed';
  const violations: Finding[] = [];
  if (evidence.readonlyWrites) violations.push('readonly_write');
  if (evidence.missingApprovals) violations.push('approval_missing');
  if (evidence.unauthorizedExternalActions) violations.push('external_unauthorized');

  const independentlyChecked = submission?.claims.every(
    (claim) =>
      claim.status === 'checked' &&
      ((claim.deadlineCalculation && evidence.checks.get('V6') === 'passed') ||
        (claim.quantityCheck && evidence.checks.get('V7') === 'passed')),
  );
  const absenceWithoutRead =
    evidence.searchesObserved === 0 &&
    submission?.claims.some(
      (claim) =>
        claim.status === 'checked' &&
        claim.sources.length === 0 &&
        /^(?:不存在|未查到|未找到|缺失|无此记录)[。！!]?$/u.test(String(claim.value).trim()),
    );

  return combined({
    task_completion: submission ? result('passed') : result('not_evaluated', 'result_missing'),
    answer_quality:
      structuralCheck === 'failed' || valueFailed
        ? result('failed', 'submission_invalid')
        : absenceWithoutRead
          ? result('failed', 'absence_without_read')
          : independentlyChecked &&
              evidence.narrativeVerified &&
              sourceCheck === 'passed' &&
              structuralCheck === 'passed'
            ? result('passed')
            : submission
              ? result('needs_review', 'claim_unverified')
              : result('not_evaluated', 'result_missing'),
    evidence:
      sourceCheck === 'failed'
        ? result('failed', 'evidence_invalid')
        : sourceCheck === 'passed' && evidence.completedEvidenceReads > 0
          ? result('passed')
          : result('not_evaluated', 'evidence_unchecked'),
    tool_reliability: evidence.unsettledTools
      ? result('failed', 'tool_unpaired')
      : evidence.failedTools
        ? result('needs_review', 'tool_failed')
        : result(evidence.totalExecutedTools ? 'passed' : 'not_evaluated'),
    policy: violations.length
      ? result('failed', ...violations)
      : evidence.totalExecutedTools && evidence.observedToolPolicies === evidence.totalExecutedTools
        ? result('passed')
        : result('not_evaluated', 'policy_not_observed'),
    efficiency:
      evidence.usage === 'over_budget'
        ? result('failed', 'budget_exceeded')
        : evidence.usage === 'within_budget'
          ? result('passed')
          : result('not_evaluated', 'usage_unmeasured'),
    collaboration: !submission
      ? result('not_evaluated', 'review_missing')
      : evidence.progressRecorded
        ? result('passed')
        : result('needs_review', 'progress_unobserved'),
  });
}

export function applySemanticReview(
  deterministic: DeterministicEvaluation,
  semantic: SemanticEvaluation,
) {
  const dimensions = structuredClone(deterministic.dimensions);
  for (const dimension of Object.keys(dimensions) as (keyof Dimensions)[]) {
    const current = dimensions[dimension];
    if (current.status === 'not_evaluated') continue;
    const observed = semantic.status === 'completed' ? semantic.dimensions[dimension] : undefined;
    const review =
      observed ??
      (dimension === 'answer_quality' || dimension === 'evidence' ? 'needs_review' : undefined);
    if (review && statuses.indexOf(review) > statuses.indexOf(current.status))
      dimensions[dimension] = result(review, ...current.findings, 'semantic_downgrade');
  }
  return combined(dimensions);
}

export function assertIndependentReviewModels(
  primary: { family: string },
  judge: { family: string },
) {
  if (primary.family.toLowerCase() === judge.family.toLowerCase())
    throw new Error('语义复核模型必须与任务模型来自不同家族。');
}
