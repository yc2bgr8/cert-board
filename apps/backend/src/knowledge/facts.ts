import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  confirmedFactSchema,
  factCandidateSchema,
  type BrowserIdentity,
  type ConfirmedFact,
  type DocumentCitation,
  type FactDecisionInput,
  type FactProposal,
  type KnowledgeGetInput,
  type ToolApprovalPreview,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { authorize } from '../auth/authorization.js';
import { quoteAppears } from '../checks/quotes.js';
import type { ToolExecutionContext, ToolUndoRecord } from '../tools/registry.js';

type Database = Pick<Pool, 'query'>;
type Project = { id: string; owner_user_id: string };
type CandidateRow = Omit<FactProposal, 'dueAt'> & {
  id: string;
  projectId: string;
  baseRevision: number;
  version: number;
  status: string;
  dataLevel: 'internal' | 'confidential';
  dueAt: Date | null;
  createdAt: Date;
};
type FactRow = Omit<ConfirmedFact, 'validFrom' | 'validUntil'> & {
  validFrom: Date;
  validUntil: Date | null;
};
type CurrentRevision = Pick<ConfirmedFact, 'id' | 'revision' | 'locked' | 'dataLevel'>;
const unavailable = () =>
  new AppError(404, 'FACT_SCOPE_NOT_FOUND', '未找到当前项目或候选，请重新打开项目。');
const changed = () =>
  new AppError(409, 'FACT_CANDIDATE_CHANGED', '候选或同字段事实已更新，请刷新后重新核对。');
const candidateCols = `c.id,c.project_id AS "projectId",c.subject,c.field,c.value,c.unit,c.evidence,
  c.base_revision AS "baseRevision",c.version,c.status,c.data_level AS "dataLevel",c.due_at AS "dueAt",c.created_at AS "createdAt"`;
const factCols = `f.id,f.subject,f.field,f.value,f.unit,c.evidence,f.revision,f.locked,f.replaces_id AS "replacesId",
  f.valid_from AS "validFrom",f.valid_until AS "validUntil",f.confirmed_by AS "confirmedBy"`;
const classification = `(SELECT v.data_level FROM document_version v
  WHERE v.document_id=d.id ORDER BY v.data_level DESC LIMIT 1)`;
const highest = (...levels: ReadonlyArray<string | null | undefined>) =>
  levels.includes('confidential') ? ('confidential' as const) : ('internal' as const);
const digest = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');

function projectForTool(ctx: ToolExecutionContext) {
  if (ctx.projectId === null) throw unavailable();
  return ctx.projectId;
}

async function readSource(db: Database, projectId: string, citation: DocumentCitation) {
  const {
    rows: [row],
  } = await db.query<{ text: string; data_level: string }>(
    `SELECT p.text,${classification} AS data_level FROM document d
       JOIN document_version v ON v.document_id=d.id AND v.version_no=$3
       JOIN document_page p ON p.version_id=v.id AND p.page_number=$4
       WHERE d.id=$2 AND d.project_id=$1 AND NOT d.voided AND NOT p.is_placeholder FOR SHARE OF d`,
    [projectId, citation.documentId, citation.version, citation.page],
  );
  if (!row || !quoteAppears(row.text, citation.quote))
    throw new AppError(
      422,
      'FACT_EVIDENCE_INVALID',
      '证据须逐字出现在本项目的有效资料页。请用 doc_read 重读并附上对应引语。',
    );
  return highest(row.data_level);
}

async function currentRevision(
  db: Database,
  projectId: string,
  key: Pick<FactProposal, 'subject' | 'field'>,
) {
  const { rows } = await db.query<CurrentRevision>(
    `SELECT f.id,f.revision,f.locked,GREATEST(f.data_level,${classification}) AS "dataLevel"
       FROM fact f JOIN fact_candidate c ON c.id=f.candidate_id JOIN document d ON d.id=c.source_document_id
       WHERE f.project_id=$1 AND f.subject=$2 AND f.field=$3 ORDER BY f.revision DESC LIMIT 1`,
    [projectId, key.subject, key.field],
  );
  return rows[0];
}

const toCandidate = (row: CandidateRow) =>
  factCandidateSchema.parse({
    ...row,
    dueAt: row.dueAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  });
const toFact = (row: FactRow) =>
  confirmedFactSchema.parse({
    ...row,
    validFrom: row.validFrom.toISOString(),
    validUntil: row.validUntil?.toISOString() ?? null,
  });

export async function previewFactProposal(
  ctx: ToolExecutionContext,
  input: FactProposal,
): Promise<ToolApprovalPreview> {
  const projectId = projectForTool(ctx);
  const level = await readSource(ctx.tx, projectId, input.evidence);
  const revision = await currentRevision(ctx.tx, projectId, input);
  return {
    summary: '创建一条待注册人员确认的事实候选',
    dataLevel: highest(ctx.maxDataLevel, level),
    targetVersions: [
      {
        targetType: 'fact',
        targetId: revision?.id ?? projectId,
        version: revision ? String(revision.revision) : null,
      },
    ],
    changes: [
      {
        recordType: 'fact_candidate',
        recordId: projectId,
        field: input.field,
        before: null,
        after: {
          subject: input.subject,
          value: input.value,
          unit: input.unit,
          dueAt: input.dueAt,
          baseRevision: revision?.revision ?? 0,
          source: {
            documentId: input.evidence.documentId,
            version: input.evidence.version,
            page: input.evidence.page,
          },
        },
      },
    ],
  };
}

export async function proposeFact(ctx: ToolExecutionContext, input: FactProposal, id: string) {
  const projectId = projectForTool(ctx);
  const level = highest(ctx.maxDataLevel, await readSource(ctx.tx, projectId, input.evidence));
  const revision = await currentRevision(ctx.tx, projectId, input);
  const {
    rows: [row],
  } = await ctx.tx.query<CandidateRow>(
    `INSERT INTO fact_candidate AS c (id,project_id,proposal_run_id,proposed_by,subject,field,value,unit,source_document_id,evidence,data_level,base_revision,due_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11,$12,$13) RETURNING ${candidateCols}`,
    [
      id,
      projectId,
      ctx.runId,
      ctx.actor.userId,
      input.subject,
      input.field,
      JSON.stringify(input.value),
      input.unit,
      input.evidence.documentId,
      JSON.stringify(input.evidence),
      level,
      revision?.revision ?? 0,
      input.dueAt,
    ],
  );
  const candidate = toCandidate(row!);
  return { data: candidate, dataLevel: level, afterVersion: candidate.version };
}

export function captureFactProposal() {
  return {
    targetType: 'fact_candidate',
    targetId: randomUUID(),
    beforeState: { existed: false },
    beforeVersion: null,
  };
}

export async function factCandidateVersion(ctx: ToolExecutionContext, id: string) {
  const { rows } = await ctx.tx.query<{ version: number }>(
    `SELECT version FROM fact_candidate WHERE id=$1 AND project_id=$2 AND proposed_by=$3 FOR UPDATE`,
    [id, projectForTool(ctx), ctx.actor.userId],
  );
  return rows[0]?.version ?? null;
}

export async function cancelFactProposal(ctx: ToolExecutionContext, record: ToolUndoRecord) {
  const { rows } = await ctx.tx.query<{ version: number }>(
    `UPDATE fact_candidate SET status='cancelled',version=version+1,updated_at=now()
       WHERE id=$1 AND project_id=$2 AND proposed_by=$3 AND status='pending' AND version=$4 RETURNING version`,
    [record.targetId, projectForTool(ctx), ctx.actor.userId, record.afterVersion],
  );
  if (!rows[0]) throw changed();
  return { afterVersion: rows[0].version };
}

export async function refreshFactProposalLevel(
  ctx: ToolExecutionContext,
  facts: { evidence: DocumentCitation; dataLevel: string },
) {
  return highest(facts.dataLevel, await readSource(ctx.tx, projectForTool(ctx), facts.evidence));
}

export async function readConfirmedFacts(
  ctx: ToolExecutionContext,
  input: Extract<KnowledgeGetInput, { kind: 'facts' }>,
) {
  const { rows } = await ctx.tx.query<FactRow>(
    `SELECT ${factCols}, GREATEST(f.data_level,${classification}) AS "dataLevel"
       FROM fact f JOIN fact_candidate c ON c.id=f.candidate_id JOIN document d ON d.id=c.source_document_id
       WHERE f.project_id=$1 AND d.project_id=$1 AND NOT d.voided
         AND ($2::text IS NULL OR f.subject=$2) AND ($3::text IS NULL OR f.field=$3)
         AND ($4::uuid IS NULL OR f.id>$4) AND f.valid_from<=now() AND (f.valid_until IS NULL OR f.valid_until>now())
         AND NOT EXISTS (SELECT 1 FROM fact newer WHERE newer.project_id=f.project_id AND newer.subject=f.subject
           AND newer.field=f.field AND newer.revision>f.revision)
       ORDER BY f.id LIMIT $5`,
    [
      projectForTool(ctx),
      input.subject ?? null,
      input.field ?? null,
      input.afterId ?? null,
      input.limit + 1,
    ],
  );
  const facts = rows.slice(0, input.limit).map(toFact);
  return {
    data: {
      kind: 'facts' as const,
      facts,
      nextAfterId: rows.length > input.limit ? facts.at(-1)!.id : null,
    },
    dataLevel: highest(...facts.map(({ dataLevel }) => dataLevel)),
  };
}

export async function refreshConfirmedFactsLevel(
  ctx: ToolExecutionContext,
  facts: ConfirmedFact[],
) {
  if (facts.length === 0) return 'internal' as const;
  const { rows } = await ctx.tx.query<{ data_level: string }>(
    `SELECT GREATEST(f.data_level,${classification}) AS data_level FROM fact f
       JOIN fact_candidate c ON c.id=f.candidate_id JOIN document d ON d.id=c.source_document_id
       WHERE f.project_id=$1 AND d.project_id=$1 AND NOT d.voided AND f.id=ANY($2::uuid[])
         AND f.valid_from<=now() AND (f.valid_until IS NULL OR f.valid_until>now())
         AND NOT EXISTS (SELECT 1 FROM fact newer WHERE newer.project_id=f.project_id AND newer.subject=f.subject
           AND newer.field=f.field AND newer.revision>f.revision)`,
    [projectForTool(ctx), facts.map(({ id }) => id)],
  );
  if (rows.length !== facts.length)
    throw new AppError(
      409,
      'FACT_RESULT_CHANGED',
      '上次读取的事实已过期、被替换或来源不可用，请重新使用 knowledge_get。',
    );
  return highest(...rows.map(({ data_level }) => data_level));
}

async function browserProject(
  db: Database,
  actor: BrowserIdentity,
  projectId: string,
  lock: boolean,
) {
  const {
    rows: [project],
  } = await db.query<Project>(
    `SELECT id,owner_user_id FROM cert_project WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
    [projectId],
  );
  if (
    !project ||
    !authorize(actor, lock ? 'record.write' : 'project.read', {
      projectId,
      ownerUserId: project.owner_user_id,
    })
  )
    throw unavailable();
  return project;
}

export async function listFactCandidates(
  db: Database,
  actor: BrowserIdentity,
  projectId: string,
  afterId?: string,
) {
  await browserProject(db, actor, projectId, false);
  const { rows } = await db.query<CandidateRow>(
    `SELECT ${candidateCols} FROM fact_candidate c WHERE c.project_id=$1 AND c.status='pending'
       AND ($2::uuid IS NULL OR c.id>$2) ORDER BY c.id LIMIT 21`,
    [projectId, afterId ?? null],
  );
  const items = rows.slice(0, 20).map(toCandidate);
  return { items, nextAfterId: rows.length > 20 ? items.at(-1)!.id : null };
}

export async function decideFactCandidate(
  db: PoolClient,
  actor: BrowserIdentity,
  projectId: string,
  candidateId: string,
  input: FactDecisionInput,
) {
  if (actor.kind !== 'browser')
    throw new AppError(403, 'FACT_BROWSER_REQUIRED', '仅接受浏览器中的人工确认。');
  const project = await browserProject(db, actor, projectId, true);
  const {
    rows: [row],
  } = await db.query<CandidateRow>(
    `SELECT ${candidateCols} FROM fact_candidate c WHERE c.id=$1 AND c.project_id=$2 FOR UPDATE`,
    [candidateId, project.id],
  );
  if (!row) throw unavailable();
  const candidate = toCandidate(row);
  if (candidate.status !== 'pending' || candidate.version !== input.expectedVersion)
    throw changed();
  if (input.decision === 'set_due') {
    const {
      rows: [changedDue],
    } = await db.query<{ version: number }>(
      `UPDATE fact_candidate SET due_at=$2,version=version+1,updated_at=now()
         WHERE id=$1 AND due_at IS DISTINCT FROM $2::timestamptz RETURNING version`,
      [candidate.id, input.dueAt],
    );
    if (changedDue)
      await db.query(
        `INSERT INTO audit_log(actor_user_id,actor_kind,action,target_type,target_id,before_hash,after_hash)
         VALUES ($1,'browser','fact.due_set','fact_candidate',$2,$3,$4)`,
        [actor.userId, candidate.id, digest(candidate.dueAt), digest(input.dueAt)],
      );
    return {
      candidateId: candidate.id,
      factId: null,
      status: 'pending',
      version: changedDue?.version ?? candidate.version,
    };
  }
  const status =
    input.decision === 'confirm'
      ? 'confirmed'
      : input.decision === 'rewrite'
        ? 'rewritten'
        : 'rejected';
  let factId: string | null = null;
  const level =
    input.decision === 'reject'
      ? candidate.dataLevel
      : highest(candidate.dataLevel, await readSource(db, projectId, candidate.evidence));
  const previous =
    input.decision === 'reject' ? undefined : await currentRevision(db, projectId, candidate);
  if (input.decision !== 'reject' && (previous?.revision ?? 0) !== candidate.baseRevision)
    throw changed();
  if (previous?.locked && project.owner_user_id !== actor.userId)
    throw new AppError(403, 'FACT_OWNER_REQUIRED', '该事实已锁定，须由项目负责人确认修订。');

  await db.query(
    `UPDATE fact_candidate SET status=$2,version=version+1,decided_by=$3,decided_at=now(),decision_reason=$4,updated_at=now() WHERE id=$1`,
    [candidate.id, status, actor.userId, input.decision === 'confirm' ? null : input.reason],
  );
  if (input.decision !== 'reject') {
    const valid = await db.query<{ accepted: boolean }>(
      'SELECT ($1::timestamptz IS NULL OR $1::timestamptz > now()) AS accepted',
      [input.validUntil],
    );
    if (!valid.rows[0]?.accepted)
      throw new AppError(422, 'FACT_VALIDITY_INVALID', '有效期须晚于确认时间，请调整结束时间。');
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO fact (project_id,subject,field,value,unit,candidate_id,data_level,revision,replaces_id,valid_until,locked,confirmed_by)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [
        projectId,
        candidate.subject,
        candidate.field,
        JSON.stringify(input.decision === 'rewrite' ? input.value : candidate.value),
        input.decision === 'rewrite' ? input.unit : candidate.unit,
        candidate.id,
        highest(level, previous?.dataLevel),
        candidate.baseRevision + 1,
        previous?.id ?? null,
        input.validUntil,
        input.locked ?? previous?.locked ?? false,
        actor.userId,
      ],
    );
    factId = rows[0]!.id;
  }
  await db.query(
    `INSERT INTO audit_log(actor_user_id,actor_kind,action,target_type,target_id,before_hash,after_hash)
       VALUES ($1,'browser',$2,'fact_candidate',$3,$4,$5)`,
    [
      actor.userId,
      `fact.${status}`,
      candidate.id,
      digest({ status: candidate.status, version: candidate.version }),
      digest({ status, version: candidate.version + 1, factId }),
    ],
  );
  return { candidateId: candidate.id, factId, status, version: candidate.version + 1 };
}
