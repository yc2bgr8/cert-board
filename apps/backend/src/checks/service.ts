import type { Pool } from 'pg';
import {
  agentIdentitySchema,
  checkContextSchema,
  checkReportSchema,
  structuredSubmissionSchema,
  type AgentIdentity,
  type CheckReport,
  type DataLevel,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { authorize } from '../auth/authorization.js';
import { checkDeadlineClaims } from './deadline-claims.js';
import { checkQuantityClaim } from './quantities.js';
import { quoteAppears } from './quotes.js';

type Database = Pick<Pool, 'query'>;
type Context = { runId: string; userId: string };
type LoadedContext = { actor: AgentIdentity; projectId: string; dataLevel: DataLevel };
type Issue = CheckReport['checks'][number]['issues'][number];
type Citation = CheckReport['citations'][number];
type Source = Citation & { text: string; dataLevel: DataLevel; isPlaceholder: boolean };
const unavailable = () =>
  new AppError(
    403,
    'CHECK_CONTEXT_UNAVAILABLE',
    '运行、用户或项目已不可访问，请刷新当前项目后重新检查。',
  );
const highest = (...values: DataLevel[]): DataLevel =>
  values.includes('confidential') ? 'confidential' : 'internal';
const notRun = ['V2', 'V4', 'V5', 'V6', 'V7', 'V8'] as const;

async function loadContext(db: Database, input: Context): Promise<LoadedContext> {
  const parsed = checkContextSchema.safeParse(input);
  if (!parsed.success) throw unavailable();
  const reference = parsed.data;
  const result = await db.query<{
    project_id: string;
    owner_user_id: string;
    username: string;
    display_name: string;
    is_development: boolean;
    is_management: boolean;
    data_level: DataLevel;
  }>(
    `SELECT r.project_id,p.owner_user_id,u.username,u.display_name,u.is_development,u.is_management,
      GREATEST(r.max_data_level,c.max_data_level,COALESCE(w.data_level,'internal'::document_data_level),
        COALESCE(wd.data_level,'internal'::document_data_level)) AS data_level
     FROM run r JOIN conversation c ON c.id=r.conversation_id JOIN app_user u ON u.id=r.user_id
     JOIN cert_project p ON p.id=r.project_id LEFT JOIN workspace w ON w.project_id=p.id
     LEFT JOIN workspace_draft wd ON wd.conversation_id=c.id LEFT JOIN goal g ON g.id=r.goal_id
     WHERE r.id=$1 AND r.user_id=$2 AND c.user_id=$2 AND c.project_id=r.project_id
       AND c.goal_id IS NOT DISTINCT FROM r.goal_id AND r.status='running' AND c.status='active'
       AND u.status='active' AND (r.goal_id IS NULL OR (g.project_id=r.project_id AND g.direction_version=r.direction_version))`,
    [reference.runId, reference.userId],
  );
  const row = result.rows[0];
  if (!row || (process.env.NODE_ENV === 'production' && row.is_development)) throw unavailable();
  const parsedActor = agentIdentitySchema.safeParse({
    kind: 'agent',
    runId: reference.runId,
    userId: reference.userId,
    username: row.username,
    displayName: row.display_name,
    isDevelopment: row.is_development,
    isManagement: row.is_management,
  });
  if (!parsedActor.success) throw unavailable();
  const actor = parsedActor.data;
  if (
    !authorize(actor, 'project.read', {
      projectId: row.project_id,
      ownerUserId: row.owner_user_id,
    }) ||
    !authorize(actor, 'workspace.read', {
      projectId: row.project_id,
      ownerUserId: row.owner_user_id,
    })
  )
    throw unavailable();
  return { actor, projectId: row.project_id, dataLevel: row.data_level };
}

async function source(
  db: Database,
  context: LoadedContext,
  ref: { documentId: string; version: number; page: number },
  includeText = true,
): Promise<Source | null> {
  const documents = await db.query<{
    owner_user_id: string;
    source_key: string;
    data_level: DataLevel;
  }>(
    `SELECT d.owner_user_id,d.source_key,(SELECT v.data_level FROM document_version v WHERE v.document_id=d.id ORDER BY v.data_level DESC LIMIT 1) AS data_level
      FROM document d WHERE d.id=$1 AND d.project_id=$2 AND NOT d.voided`,
    [ref.documentId, context.projectId],
  );
  const document = documents.rows[0];
  if (
    !document ||
    !authorize(context.actor, 'document.read', {
      projectId: context.projectId,
      ownerUserId: document.owner_user_id,
    })
  )
    return null;
  const pages = await db.query<{
    text: string;
    locatorKind: Citation['locatorKind'];
    method: Citation['method'];
    ocrScore: number | null;
    isPlaceholder: boolean;
  }>(
    `SELECT ${includeText ? 'p.text' : "''::text AS text"},p.locator_kind AS "locatorKind",p.method,p.ocr_score AS "ocrScore",p.is_placeholder AS "isPlaceholder"
     FROM document_page p JOIN document_version v ON v.id=p.version_id JOIN document d ON d.id=v.document_id
     WHERE d.id=$1 AND d.project_id=$2 AND NOT d.voided AND v.version_no=$3 AND p.page_number=$4`,
    [ref.documentId, context.projectId, ref.version, ref.page],
  );
  const page = pages.rows[0];
  return page
    ? {
        documentId: ref.documentId,
        version: ref.version,
        page: ref.page,
        sourceKey: document.source_key,
        ...page,
        dataLevel: document.data_level,
      }
    : null;
}

export async function checkSubmission(
  db: Database,
  contextInput: Context,
  input: unknown,
): Promise<CheckReport> {
  const context = await loadContext(db, contextInput);
  const parsed = structuredSubmissionSchema.safeParse(input);
  if (!parsed.success)
    return checkReportSchema.parse({
      passed: false,
      dataLevel: context.dataLevel,
      checks: [
        { code: 'V1', status: 'not_run', issues: [] },
        { code: 'V3', status: 'failed', issues: [{ code: 'schema_invalid', path: 'submission' }] },
      ],
      notRun,
      citations: [],
    });
  const submission = parsed.data;
  const v1: Issue[] = [],
    v3: Issue[] = [],
    v7: Issue[] = [];
  let checkedQuantity = false;
  let dataLevel = context.dataLevel;
  const workspace = await db.query<{ data_level: DataLevel }>(
    `SELECT v.data_level FROM workspace_version v JOIN workspace w ON w.id=v.workspace_id
     JOIN workspace_version current ON current.id=w.current_version_id AND current.workspace_id=w.id
     WHERE v.id=$1 AND v.project_id=$2 AND w.project_id=$2 AND v.number<=current.number`,
    [submission.workspaceVersion, context.projectId],
  );
  if (!workspace.rows[0])
    return checkReportSchema.parse({
      passed: false,
      dataLevel,
      checks: [
        { code: 'V1', status: 'not_run', issues: [] },
        {
          code: 'V3',
          status: 'failed',
          issues: [{ code: 'workspace_version_unavailable', path: 'workspaceVersion' }],
        },
      ],
      notRun,
      citations: [],
    });
  dataLevel = highest(dataLevel, workspace.rows[0].data_level);
  const cache = new Map<string, Source | null>();
  const citations = new Map<string, Citation>();
  const checkCitation = async (
    ref: { documentId: string; version: number; page: number; quote: string },
    path: string,
  ) => {
    const key = `${ref.documentId}:${ref.version}:${ref.page}`;
    if (!cache.has(key)) cache.set(key, await source(db, context, ref));
    const found = cache.get(key);
    if (!found) {
      v1.push({ code: 'source_unavailable', path });
      return;
    }
    dataLevel = highest(dataLevel, found.dataLevel);
    if (found.isPlaceholder) {
      v1.push({ code: 'placeholder_source', path });
      return;
    }
    citations.set(key, {
      documentId: found.documentId,
      sourceKey: found.sourceKey,
      version: found.version,
      page: found.page,
      locatorKind: found.locatorKind,
      method: found.method,
      ocrScore: found.ocrScore,
    });
    if (!quoteAppears(found.text, ref.quote)) v1.push({ code: 'quote_mismatch', path });
  };
  for (const [index, claim] of submission.claims.entries()) {
    if (claim.quantityCheck) {
      checkedQuantity = true;
      const code = checkQuantityClaim(claim);
      if (code) v7.push({ code, path: `claims[${index}].value` });
    } else if (typeof claim.value === 'number' || claim.unit !== null)
      v3.push({ code: 'unsupported_quantity', path: `claims[${index}]` });
    if (claim.sources.length === 0)
      v1.push({ code: 'missing_evidence', path: `claims[${index}].sources` });
    for (const [position, citation] of claim.sources.entries())
      await checkCitation(citation, `claims[${index}].sources[${position}]`);
  }
  for (const [index, decision] of submission.decisions.entries())
    for (const [position, citation] of decision.sources.entries())
      await checkCitation(citation, `decisions[${index}].sources[${position}]`);
  if (submission.evidence.length === 0) v1.push({ code: 'missing_evidence', path: 'evidence' });
  for (const [index, citation] of submission.evidence.entries())
    await checkCitation(citation, `evidence[${index}]`);
  const v6 = checkDeadlineClaims(submission);
  return checkReportSchema.parse({
    passed: v1.length === 0 && v3.length === 0 && v6.issues.length === 0 && v7.length === 0,
    dataLevel,
    checks: [
      { code: 'V1', status: v1.length ? 'failed' : 'passed', issues: v1 },
      { code: 'V3', status: v3.length ? 'failed' : 'passed', issues: v3 },
      ...(v6.ran
        ? [{ code: 'V6', status: v6.issues.length ? 'failed' : 'passed', issues: v6.issues }]
        : []),
      ...(checkedQuantity
        ? [{ code: 'V7', status: v7.length ? 'failed' : 'passed', issues: v7 }]
        : []),
    ],
    notRun: notRun.filter((code) => !(code === 'V6' && v6.ran) && !(code === 'V7' && checkedQuantity)),
    citations: [...citations.values()],
  });
}

export async function refreshCheckDataLevel(
  db: Database,
  contextInput: Context,
  citations: CheckReport['citations'],
): Promise<DataLevel> {
  const context = await loadContext(db, contextInput);
  const parsed = checkReportSchema.shape.citations.safeParse(citations);
  if (!parsed.success)
    throw new AppError(
      400,
      'CHECK_SOURCE_INVALID',
      '检查来源定位无效，请重新运行检查取得当前引用。',
    );
  let dataLevel = context.dataLevel;
  for (const citation of parsed.data) {
    const found = await source(db, context, citation, false);
    if (!found || found.isPlaceholder)
      throw new AppError(
        404,
        'CHECK_SOURCE_UNAVAILABLE',
        '检查所引的有效资料已不可访问，请重新读取当前资料并检查。',
      );
    dataLevel = highest(dataLevel, found.dataLevel);
  }
  return dataLevel;
}
