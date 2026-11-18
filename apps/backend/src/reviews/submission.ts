import {
  structuredSubmissionSchema,
  documentPageReadSchema,
  toolStoredPayloadSchema,
  reviewSubmitResultSchema,
  checkReportSchema,
  type DocumentCitation,
  type ReviewPolicy,
  type DataLevel,
  type WorkspaceFileDescriptor,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { authorize } from '../auth/authorization.js';
import { checkSubmission, refreshCheckDataLevel } from '../checks/service.js';
import { normalizeWhitespace, quoteAppears } from '../checks/quotes.js';
import { compareFileManifests } from '../workspace/diff.js';
import type { ToolExecutionContext, ToolUndoRecord } from '../tools/registry.js';
import { requireReviewPolicy } from './policy.js';
import { reviewContentHash } from './content.js';

const error = (code: string, message: string, status = 422) => new AppError(status, code, message);
const key = (ref: DocumentCitation) =>
  JSON.stringify([ref.documentId, ref.version, ref.page, normalizeWhitespace(ref.quote)]);
const highest = (...values: DataLevel[]): DataLevel =>
  values.includes('confidential') ? 'confidential' : 'internal';
type EvidenceReference = DocumentCitation & { readInvocationId: string };
async function requireSourceAccess(
  ctx: ToolExecutionContext,
  references: readonly { documentId: string }[],
) {
  const ids = [...new Set(references.map((ref) => ref.documentId))];
  const documents = await ctx.tx.query<{ id: string; owner_user_id: string }>(
    'SELECT id,owner_user_id FROM document WHERE id=ANY($1::uuid[]) AND project_id=$2 AND NOT voided FOR SHARE',
    [ids, ctx.projectId],
  );
  if (
    documents.rowCount !== ids.length ||
    documents.rows.some(
      (document) =>
        !authorize(ctx.actor, 'document.read', {
          projectId: ctx.projectId,
          ownerUserId: document.owner_user_id,
        }),
    )
  )
    throw error(
      'REVIEW_SOURCE_UNAVAILABLE',
      '本工具当前角色范围无法读取全部引用资料，请重新核对项目权限与有效来源。',
      403,
    );
}
async function manifest(
  ctx: ToolExecutionContext,
  versionId: string | null,
): Promise<WorkspaceFileDescriptor[]> {
  if (!versionId) return [];
  const rows = await ctx.tx.query<Omit<WorkspaceFileDescriptor, 'byteSize'> & { byteSize: string }>(
    'SELECT path,sha256,byte_size AS "byteSize",data_level AS "dataLevel",media_type AS "mediaType" FROM workspace_file WHERE version_id=$1 ORDER BY path LIMIT 10001',
    [versionId],
  );
  if (rows.rows.length > 10000)
    throw error('REVIEW_FILE_LIMIT', '工作区文件过多，请缩小交付范围后再提交。', 413);
  return rows.rows.map((file) => ({ ...file, byteSize: Number(file.byteSize) }));
}

async function verifyReadReceipts(
  ctx: ToolExecutionContext,
  references: DocumentCitation[],
): Promise<EvidenceReference[]> {
  const unique = [...new Map(references.map((ref) => [key(ref), ref])).values()];
  const receipts = new Map<
    string,
    Array<{ invocationId: string; data: ReturnType<typeof documentPageReadSchema.parse> }>
  >();
  const proofs: EvidenceReference[] = [];
  for (const ref of unique) {
    const location = JSON.stringify([ref.documentId, ref.version, ref.page]);
    if (!receipts.has(location)) {
      const rows = await ctx.tx.query<{
        invocation_id: string;
        content_json: unknown;
        content_sha256: string;
      }>(
        `SELECT ti.id AS invocation_id,tr.content_json,v.content_sha256 FROM tool_invocation ti
         JOIN conversation_tool_result tr ON tr.invocation_id=ti.id AND tr.conversation_id=ti.conversation_id AND tr.user_id=ti.user_id
         JOIN document d ON d.id=$3 AND d.project_id=$6 AND NOT d.voided
         JOIN document_version v ON v.document_id=d.id AND v.version_no=$4
         WHERE ti.conversation_id=$1 AND ti.user_id=$2 AND ti.tool_name='doc_read' AND ti.effect='read'
           AND ti.operation='execute' AND ti.status='completed'
           AND tr.content_json #>> '{result,data,documentId}'=$3::text
           AND tr.content_json #>> '{result,data,version}'=$4::text
           AND tr.content_json #>> '{result,data,page}'=$5::text
         ORDER BY ti.created_at DESC,ti.id DESC LIMIT 200`,
        [
          ctx.conversationId,
          ctx.actor.userId,
          ref.documentId,
          ref.version,
          ref.page,
          ctx.projectId,
        ],
      );
      const valid: Array<{
        invocationId: string;
        data: ReturnType<typeof documentPageReadSchema.parse>;
      }> = [];
      for (const row of rows.rows) {
        const payload = toolStoredPayloadSchema.safeParse(row.content_json);
        if (!payload.success || payload.data.status !== 'completed') continue;
        const data = documentPageReadSchema.safeParse(payload.data.result.data);
        if (data.success && data.data.contentSha256 === row.content_sha256)
          valid.push({ invocationId: row.invocation_id, data: data.data });
      }
      receipts.set(location, valid);
    }
    const read = receipts
      .get(location)!
      .find((receipt) => quoteAppears(receipt.data.text, ref.quote));
    if (!read)
      throw error(
        'REVIEW_READ_REQUIRED',
        '每条完整引语必须出现在本对话成功的doc_read回执中；请重新读取对应版本和页码，确保一段返回文本完整包含引语后再提交。',
      );
    proofs.push({ ...ref, readInvocationId: read.invocationId });
  }
  return proofs;
}

export async function submitReview(
  ctx: ToolExecutionContext,
  input: unknown,
  reviewId: string,
  policyInput: ReviewPolicy,
) {
  const policy = requireReviewPolicy(policyInput);
  const parsed = structuredSubmissionSchema.safeParse(input);
  if (!parsed.success)
    throw error('REVIEW_INPUT_INVALID', '结构化交付格式无效，请先用check_run修正后再提交。');
  const submission = parsed.data;
  if (!ctx.projectId || !ctx.goalId || ctx.goalStatus !== 'active' || ctx.mode !== 'execute')
    throw error('REVIEW_CONTEXT_INVALID', '请在本人活动目标的执行对话中提交审核。', 403);
  if (submission.skill.id !== policy.skill.id || submission.skill.version !== policy.skill.version)
    throw error(
      'REVIEW_SKILL_UNAVAILABLE',
      '提交技能与当前已登记开发草稿不符，请读取当前技能版本后重新提交。',
    );
  const invocation = await ctx.tx.query<{ id: string }>(
    `SELECT id FROM tool_invocation WHERE run_id=$1 AND call_id=$2 AND user_id=$3 AND conversation_id=$4
       AND tool_name='submit_for_review' AND effect='reversible_write' AND operation='execute' AND status='started'`,
    [ctx.runId, ctx.callId, ctx.actor.userId, ctx.conversationId],
  );
  if (invocation.rowCount !== 1)
    throw error(
      'REVIEW_REGISTERED_TOOL_REQUIRED',
      '提交审核必须经过已登记业务工具，不能直接建立审核卡。',
      403,
    );
  const workspace = await ctx.tx.query<{ current_version_id: string }>(
    'SELECT current_version_id FROM workspace WHERE project_id=$1 FOR UPDATE',
    [ctx.projectId],
  );
  if (workspace.rows[0]?.current_version_id !== submission.workspaceVersion)
    throw error(
      'REVIEW_WORKSPACE_STALE',
      '工作区已有新版本，请读取差异并按最新已保存版本重新检查和提交。',
      409,
    );
  const references = [
    ...submission.claims.flatMap((claim) => claim.sources),
    ...submission.evidence,
  ];
  await requireSourceAccess(ctx, references);
  const checks = await checkSubmission(
    ctx.tx,
    { runId: ctx.runId, userId: ctx.actor.userId },
    submission,
  );
  if (
    !checks.passed ||
    !policy.requiredChecks.every((required) =>
      checks.checks.some((check) => check.code === required && check.status === 'passed'),
    )
  )
    throw error(
      'REVIEW_CHECK_FAILED',
      '关键检查未通过，未建立审核卡；请运行check_run查看具体问题并修正引语、来源或交付格式。',
    );
  const uniqueEvidence = new Map(submission.evidence.map((ref) => [key(ref), ref]));
  if (uniqueEvidence.size < policy.minimumEvidence)
    throw error(
      'REVIEW_EVIDENCE_INSUFFICIENT',
      '至少需要两条不同的完整资料引语；重复引语或仅改变空白不会增加证据数，请补充实际读取的依据。',
    );
  const evidenceRefs = await verifyReadReceipts(ctx, references);
  const previous = await ctx.tx.query<{ workspace_version_id: string }>(
    "SELECT workspace_version_id FROM review_card WHERE project_id=$1 AND status='approved' ORDER BY decided_at DESC,id DESC LIMIT 1",
    [ctx.projectId],
  );
  const baseVersionId = previous.rows[0]?.workspace_version_id ?? null;
  const changes = compareFileManifests(
    await manifest(ctx, baseVersionId),
    await manifest(ctx, submission.workspaceVersion),
  ).map((change) => ({
    path: change.path,
    change: change.change,
    beforeSha256: change.before?.sha256 ?? null,
    afterSha256: change.after?.sha256 ?? null,
  }));
  if (changes.length > 1000)
    throw error('REVIEW_DIFF_LIMIT', '本次改动超过1000个文件，请缩小交付范围后再提交审核。', 413);
  const diff = { baseVersionId, changes };
  const contentHash = reviewContentHash({
    submission,
    checks,
    diff,
    evidenceRefs,
    risk: policy.risk,
    cardType: policy.cardType,
  });
  const dataLevel = highest(ctx.maxDataLevel, checks.dataLevel);
  await ctx.tx.query(
    `INSERT INTO review_card(id,project_id,goal_id,conversation_id,run_id,invocation_id,created_by,workspace_version_id,skill_id,skill_version,risk,card_type,structured_result,check_report,diff,evidence_refs,content_hash,data_level)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      reviewId,
      ctx.projectId,
      ctx.goalId,
      ctx.conversationId,
      ctx.runId,
      invocation.rows[0]!.id,
      ctx.actor.userId,
      submission.workspaceVersion,
      policy.skill.id,
      policy.skill.version,
      policy.risk,
      policy.cardType,
      submission,
      checks,
      diff,
      JSON.stringify(evidenceRefs),
      contentHash,
      dataLevel,
    ],
  );
  await ctx.tx.query(
    "INSERT INTO audit_log(actor_user_id,actor_kind,action,target_type,target_id,after_hash) VALUES($1,'agent','review.submitted','review_card',$2,$3)",
    [ctx.actor.userId, reviewId, contentHash],
  );
  return {
    data: reviewSubmitResultSchema.parse({
      reviewId,
      version: 1,
      status: 'pending',
      workspaceVersion: submission.workspaceVersion,
      skill: policy.skill,
      requiresBrowserDecision: true,
    }),
    dataLevel,
    afterVersion: '1',
  };
}

export async function reviewVersion(
  ctx: ToolExecutionContext,
  reviewId: string,
): Promise<string | null> {
  const row = (
    await ctx.tx.query<{ version: number }>(
      'SELECT version FROM review_card WHERE id=$1 AND project_id=$2 AND conversation_id=$3 AND created_by=$4 FOR UPDATE',
      [reviewId, ctx.projectId, ctx.conversationId, ctx.actor.userId],
    )
  ).rows[0];
  return row ? String(row.version) : null;
}
export async function cancelPendingReview(ctx: ToolExecutionContext, record: ToolUndoRecord) {
  const invocation = await ctx.tx.query(
    `SELECT id FROM tool_invocation WHERE run_id=$1 AND call_id=$2 AND conversation_id=$3 AND user_id=$4
     AND tool_name='submit_for_review' AND operation='undo' AND effect='reversible_write' AND status='started'`,
    [ctx.runId, ctx.callId, ctx.conversationId, ctx.actor.userId],
  );
  if (invocation.rowCount !== 1)
    throw error('REVIEW_REGISTERED_TOOL_REQUIRED', '撤销审核必须经过已登记工具与撤销记录。', 403);
  const changed = await ctx.tx.query<{ version: number }>(
    "UPDATE review_card SET status='cancelled',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND project_id=$2 AND conversation_id=$3 AND created_by=$4 AND status='pending' AND version=$5 RETURNING version",
    [record.targetId, ctx.projectId, ctx.conversationId, ctx.actor.userId, record.afterVersion],
  );
  if (!changed.rows[0])
    throw error(
      'REVIEW_CANNOT_UNDO',
      '审核卡已有决定或版本已改变，不能撤销；请查看当前审核状态。',
      409,
    );
  await ctx.tx.query(
    "INSERT INTO audit_log(actor_user_id,actor_kind,action,target_type,target_id) VALUES($1,'agent','review.cancelled','review_card',$2)",
    [ctx.actor.userId, record.targetId],
  );
  return { afterVersion: String(changed.rows[0].version) };
}
export async function refreshReviewDataLevel(
  ctx: ToolExecutionContext,
  output: unknown,
): Promise<DataLevel> {
  const parsed = reviewSubmitResultSchema.safeParse(output);
  if (!parsed.success) throw error('REVIEW_RESULT_INVALID', '审核回执无效，请重新查询审核卡。');
  const card = (
    await ctx.tx.query<{
      version: number;
      status: string;
      check_report: unknown;
      data_level: DataLevel;
    }>(
      'SELECT version,status,check_report,data_level FROM review_card WHERE id=$1 AND project_id=$2 AND conversation_id=$3 AND created_by=$4',
      [parsed.data.reviewId, ctx.projectId, ctx.conversationId, ctx.actor.userId],
    )
  ).rows[0];
  const invocation = (
    await ctx.tx.query<{ operation: string }>(
      "SELECT operation FROM tool_invocation WHERE run_id=$1 AND call_id=$2 AND conversation_id=$3 AND user_id=$4 AND tool_name='submit_for_review' AND effect='reversible_write'",
      [ctx.runId, ctx.callId, ctx.conversationId, ctx.actor.userId],
    )
  ).rows[0];
  const isCancelledUndo =
    invocation?.operation === 'undo' &&
    card?.status === 'cancelled' &&
    card.version === parsed.data.version + 1;
  if (
    !card ||
    (!isCancelledUndo && (card.status !== 'pending' || card.version !== parsed.data.version))
  )
    throw error(
      'REVIEW_RESULT_STALE',
      '审核卡状态已经变化，请查看当前卡片，不要重复提交旧回执。',
      409,
    );
  const report = checkReportSchema.safeParse(card.check_report);
  if (!report.success)
    throw error('REVIEW_RESULT_INVALID', '审核检查记录无效，请联系维护人员核对。');
  await requireSourceAccess(ctx, report.data.citations);
  return highest(
    ctx.maxDataLevel,
    card.data_level,
    await refreshCheckDataLevel(
      ctx.tx,
      { runId: ctx.runId, userId: ctx.actor.userId },
      report.data.citations,
    ),
  );
}
