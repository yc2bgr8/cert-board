import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  evaluationStatusViewSchema,
  type CheckReport,
  type SemanticEvaluation,
  type StructuredSubmission,
} from '@cert-board/shared';
import { applySemanticReview, assessRun, evaluationVersion } from './assessment.js';

type Query = Pick<Pool | PoolClient, 'query'>;
type Observations = {
  successfulTools: number;
  pairedProofs: number;
  expectedProofs: number;
  searchesObserved: number;
  unpairedTools: number;
  failedTools: number;
  policiesObserved: number;
  readOnlyWrites: number;
  missingApprovals: number;
  unauthorizedExternal: number;
  budgetExceeded: boolean;
  meteringComplete: boolean;
  progressRecorded: boolean;
};

async function observe(
  db: Query,
  runId: string,
  invocationId: string | null,
  evidenceIds: readonly string[],
) {
  return (
    await db.query<Observations>(
      `WITH calls AS (
      SELECT i.*,(i.status='completed' OR COALESCE(i.id=$2,false)) AS succeeded,t.invocation_id IS NOT NULL AS paired
      FROM tool_invocation i LEFT JOIN conversation_tool_result t ON t.invocation_id=i.id WHERE i.run_id=$1
    )
    SELECT count(*) FILTER(WHERE succeeded)::int AS "successfulTools",
      (SELECT count(*)::int FROM tool_invocation i JOIN conversation_tool_result t ON t.invocation_id=i.id
        JOIN run r ON r.id=$1 AND r.conversation_id=i.conversation_id
        WHERE i.id=ANY($3::uuid[]) AND i.status='completed' AND i.tool_name='doc_read') AS "pairedProofs",
      cardinality($3::uuid[]) AS "expectedProofs",
      count(*) FILTER(WHERE succeeded AND paired AND tool_name IN ('doc_search','doc_read','official_lookup','ledger_query','record_get'))::int AS "searchesObserved",
      count(*) FILTER(WHERE (status='started' OR (status='completed' AND NOT paired)) AND id IS DISTINCT FROM $2::uuid)::int AS "unpairedTools",
      (SELECT count(*)::int FROM run_event WHERE run_id=$1 AND type='tool_failed') AS "failedTools",
      count(*) FILTER(WHERE succeeded AND evaluated_mode IS NOT NULL)::int AS "policiesObserved",
      count(*) FILTER(WHERE succeeded AND evaluated_mode='read_only' AND effect<>'read')::int AS "readOnlyWrites",
      count(*) FILTER(WHERE succeeded AND operation='execute' AND requires_process_approval
        AND NOT EXISTS (SELECT 1 FROM tool_approval a JOIN tool_approval_decision d ON d.approval_id=a.id
          WHERE a.invocation_id=calls.id AND a.status='approved' AND d.action IN ('allow_once','allow_conversation')
            AND d.created_at<=calls.updated_at)
        AND NOT EXISTS (SELECT 1 FROM conversation_tool_grant g WHERE g.conversation_id=calls.conversation_id
          AND g.user_id=calls.user_id AND g.tool_name=calls.tool_name AND g.tool_version=calls.tool_version
          AND g.created_at<=calls.created_at AND (g.revoked_at IS NULL OR g.revoked_at>calls.created_at)))::int AS "missingApprovals",
      (SELECT count(*)::int FROM proposal p JOIN outbound_message o ON o.proposal_id=p.id
        LEFT JOIN decision d ON d.id=o.decision_id AND d.proposal_id=p.id
        WHERE p.run_id=$1 AND (d.id IS NULL OR d.action<>'approved' OR d.created_at>o.created_at)) AS "unauthorizedExternal",
      EXISTS(SELECT 1 FROM run_event WHERE run_id=$1 AND type='budget_stopped') AS "budgetExceeded",
      (SELECT count(*)>0 AND bool_and(status='settled') FROM usage_ledger WHERE run_id=$1) AS "meteringComplete",
      EXISTS(SELECT 1 FROM conversation_event WHERE run_id=$1 AND type='plan_updated') AS "progressRecorded"
    FROM calls`,
      [runId, invocationId, evidenceIds],
    )
  ).rows[0]!;
}

function assessObservations(
  observed: Observations,
  submission: StructuredSubmission | null,
  checks: readonly CheckReport['checks'][number][],
) {
  return assessRun({
    submission,
    checks: new Map(checks.map(({ code, status }) => [code, status])),
    narrativeVerified: false,
    completedEvidenceReads:
      observed.expectedProofs === observed.pairedProofs ? observed.pairedProofs : 0,
    searchesObserved: observed.searchesObserved,
    unsettledTools: observed.unpairedTools,
    failedTools: observed.failedTools,
    observedToolPolicies: observed.policiesObserved,
    totalExecutedTools: observed.successfulTools,
    readonlyWrites: observed.readOnlyWrites,
    missingApprovals: observed.missingApprovals,
    unauthorizedExternalActions: observed.unauthorizedExternal,
    usage: observed.budgetExceeded
      ? 'over_budget'
      : observed.meteringComplete
        ? 'within_budget'
        : 'unmeasured',
    progressRecorded: observed.progressRecorded,
  });
}

export async function captureReviewEvaluation(
  db: PoolClient,
  input: {
    runId: string;
    reviewId: string;
    invocationId: string;
    contentHash: string;
    submission: StructuredSubmission;
    checks: CheckReport;
    evidenceRefs: readonly { readInvocationId: string }[];
  },
) {
  await db.query('SAVEPOINT review_evaluation');
  try {
    const observed = await observe(db, input.runId, input.invocationId, [
      ...new Set(input.evidenceRefs.map(({ readInvocationId }) => readInvocationId)),
    ]);
    const report = assessObservations(observed, input.submission, input.checks.checks);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([input.contentHash, observed]))
      .digest('hex');
    await db.query(
      `INSERT INTO eval_report(run_id,review_id,scheme_version,input_fingerprint,deterministic,semantic,result)
       VALUES($1,$2,$3,$4,$5,'{"status":"not_evaluated"}'::jsonb,$6)
       ON CONFLICT(run_id,scheme_version,input_fingerprint) DO NOTHING`,
      [
        input.runId,
        input.reviewId,
        evaluationVersion,
        fingerprint,
        report,
        applySemanticReview(report, { status: 'not_evaluated' }),
      ],
    );
  } catch {
    await db.query('ROLLBACK TO SAVEPOINT review_evaluation');
    await db.query(
      "INSERT INTO audit_log(actor_kind,action,target_type,target_id) VALUES('system','evaluation.unavailable','review_card',$1)",
      [input.reviewId],
    );
  }
  await db.query('RELEASE SAVEPOINT review_evaluation');
}

export async function captureRunEvaluation(pool: Pool, runId: string, status: string) {
  try {
    const observed = await observe(pool, runId, null, []);
    const report = assessObservations(observed, null, []);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([status, observed]))
      .digest('hex');
    await pool.query(
      `INSERT INTO eval_report(run_id,scheme_version,input_fingerprint,deterministic,semantic,result)
     SELECT r.id,$2,$3,$4,'{"status":"not_evaluated"}'::jsonb,$4 FROM run r
     WHERE r.id=$1 AND r.status::text=$5 AND r.status NOT IN ('queued','running')
       AND NOT EXISTS(SELECT 1 FROM review_card c WHERE c.run_id=r.id)
     ON CONFLICT(run_id,scheme_version,input_fingerprint) DO NOTHING`,
      [runId, evaluationVersion, fingerprint, report, status],
    );
  } catch {
    await pool
      .query(
        "INSERT INTO audit_log(actor_kind,action,target_type,target_id) VALUES('system','evaluation.unavailable','run',$1)",
        [runId],
      )
      .catch(() => console.warn('EVALUATION_AUDIT_DEFERRED', runId));
  }
}

async function latestEvaluation(db: Query, runId: string, reviewId: string) {
  const {
    rows: [row],
  } = await db.query<{
    id: string;
    version: string;
    deterministic: unknown;
    semantic: unknown;
    result: unknown;
  }>(
    `SELECT id,scheme_version AS version,deterministic,semantic,result FROM eval_report
     WHERE run_id=$1 AND review_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`,
    [runId, reviewId],
  );
  if (!row) return null;
  const { id, ...payload } = row;
  const parsed = evaluationStatusViewSchema.safeParse(payload);
  return parsed.success ? { id, view: parsed.data } : null;
}

export async function readReviewEvaluation(db: Query, runId: string, reviewId: string) {
  return (await latestEvaluation(db, runId, reviewId))?.view ?? null;
}

export async function updateSemanticEvaluation(
  db: Query,
  runId: string,
  reviewId: string,
  semantic: SemanticEvaluation,
) {
  const stored = await latestEvaluation(db, runId, reviewId);
  if (!stored || stored.view.semantic.status === 'completed') return;
  const result = applySemanticReview(stored.view.deterministic, semantic);
  await db.query(
    `UPDATE eval_report SET semantic=$2,result=$3,updated_at=clock_timestamp() WHERE id=$1
       AND semantic->>'status'<>'completed'`,
    [stored.id, semantic, result],
  );
}
