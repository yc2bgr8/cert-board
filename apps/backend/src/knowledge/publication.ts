import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  knowledgeDraftSchema,
  knowledgeReviewCreateSchema,
  knowledgeReviewDecisionSchema,
  knowledgeReviewDetailSchema,
  knowledgeReviewPageSchema,
  knowledgeReviewSummarySchema,
  publishedTemplateSchema,
  templateSeedSchema,
  type BrowserIdentity,
  type KnowledgeDraft,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import type { ToolExecutionContext } from '../tools/registry.js';
import { parseKnowledgeSeedYaml } from './rule-packs.js';

type ReviewRow = {
  id: string;
  kind: KnowledgeDraft['kind'];
  code: string;
  version: string;
  title: string;
  content: unknown;
  content_sha256: string;
  status: 'pending' | 'published' | 'rejected';
  author_id: string;
  reviewer_id: string | null;
  decision_request_key: string | null;
  reason: string | null;
  created_at: Date;
  reviewed_at: Date | null;
};

const reviewColumns = `id,kind,code,version,content->>'title' AS title,content_sha256,
  status,author_id,reviewer_id,decision_request_key,reason,created_at,reviewed_at`;
const notFound = () => new AppError(404, 'KNOWLEDGE_REVIEW_NOT_FOUND', '找不到这张知识审核卡。');
const conflict = () =>
  new AppError(409, 'KNOWLEDGE_REVIEW_CONFLICT', '审核状态或版本已改变，请刷新并核对。');
const invalidDraft = () =>
  new AppError(400, 'KNOWLEDGE_DRAFT_INVALID', '草稿格式无效，请核对 YAML、版本和来源字段。');
const versionNotNewer = () =>
  new AppError(
    409,
    'KNOWLEDGE_VERSION_NOT_NEWER',
    '正式版本号须高于当前发布版本，请另登记一个新版本。',
  );

function summarize(row: ReviewRow) {
  return knowledgeReviewSummarySchema.parse({
    id: row.id,
    kind: row.kind,
    code: row.code,
    title: row.title,
    version: row.version,
    status: row.status,
    contentSha256: row.content_sha256,
    createdAt: row.created_at.toISOString(),
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    reason: row.reason,
  });
}

export async function listKnowledgeReviews(db: Pick<PoolClient, 'query'>, afterId?: string) {
  if (afterId) {
    const cursor = await db.query('SELECT 1 FROM knowledge_review WHERE id=$1', [afterId]);
    if (!cursor.rowCount) throw notFound();
  }
  const { rows } = await db.query<ReviewRow>(
    `SELECT ${reviewColumns} FROM knowledge_review
      WHERE $1::uuid IS NULL OR (created_at,id) <
        (SELECT created_at,id FROM knowledge_review WHERE id=$1)
      ORDER BY created_at DESC,id DESC LIMIT 41`,
    [afterId ?? null],
  );
  const items = rows.slice(0, 40).map(summarize);
  return knowledgeReviewPageSchema.parse({
    items,
    nextAfterId: rows.length > 40 ? items.at(-1)?.id : null,
  });
}

export async function getKnowledgeReview(db: Pick<PoolClient, 'query'>, id: string) {
  const {
    rows: [review],
  } = await db.query<ReviewRow>(
    `SELECT ${reviewColumns},content FROM knowledge_review WHERE id=$1`,
    [id],
  );
  if (!review) throw notFound();
  return knowledgeReviewDetailSchema.parse({
    ...summarize(review),
    draft: { kind: review.kind, content: review.content },
  });
}

export async function stageKnowledgeReview(
  db: PoolClient,
  actor: BrowserIdentity,
  input: z.infer<typeof knowledgeReviewCreateSchema>,
) {
  if (!actor.isManagement)
    throw new AppError(403, 'MANAGEMENT_REQUIRED', '请由系统维护人员登记规则包或模板草稿。');
  let draft: KnowledgeDraft;
  if ('sourceReviewId' in input) {
    const source = await getKnowledgeReview(db, input.sourceReviewId);
    if (source.status !== 'published' || source.kind !== input.kind) throw conflict();
    draft = knowledgeDraftSchema.parse({
      kind: source.kind,
      content: { ...source.draft.content, version: input.version },
    });
  } else {
    try {
      draft = knowledgeDraftSchema.parse({
        kind: input.kind,
        content: parseKnowledgeSeedYaml(input.yaml, '知识草稿'),
      });
    } catch {
      throw invalidDraft();
    }
  }
  const { code, version } = draft.content;
  const encoded = JSON.stringify(draft.content);
  const hash = createHash('sha256').update(encoded).digest('hex');
  const {
    rows: [created],
  } = await db.query<ReviewRow>(
    `INSERT INTO knowledge_review(kind,code,version,content,content_sha256,author_id,request_key)
      VALUES($1,$2,$3,$4::jsonb,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING ${reviewColumns}`,
    [draft.kind, code, version, encoded, hash, actor.userId, input.requestKey],
  );
  if (created) {
    await audit(db, actor.userId, created.id, 'knowledge.review_staged', hash);
    return summarize(created);
  }
  const {
    rows: [prior],
  } = await db.query<ReviewRow>(
    `SELECT ${reviewColumns} FROM knowledge_review
      WHERE author_id=$1 AND request_key=$2 AND content=$3::jsonb`,
    [actor.userId, input.requestKey, encoded],
  );
  if (!prior || prior.kind !== draft.kind) throw conflict();
  return summarize(prior);
}

export async function decideKnowledgeReview(
  db: PoolClient,
  actor: BrowserIdentity,
  id: string,
  input: z.infer<typeof knowledgeReviewDecisionSchema>,
) {
  const {
    rows: [review],
  } = await db.query<ReviewRow>(
    `SELECT ${reviewColumns},content FROM knowledge_review WHERE id=$1 FOR UPDATE`,
    [id],
  );
  if (!review) throw notFound();
  if (review.content_sha256 !== input.contentSha256) throw conflict();
  const status = input.action === 'publish' ? 'published' : 'rejected';
  const reason = input.action === 'reject' ? input.reason : null;
  if (review.status !== 'pending') {
    if (
      review.status === status &&
      review.reviewer_id === actor.userId &&
      review.decision_request_key === input.requestKey &&
      review.reason === reason
    )
      return summarize(review);
    throw conflict();
  }

  const draft = knowledgeDraftSchema.parse({ kind: review.kind, content: review.content });
  if (
    status === 'published' &&
    draft.kind === 'rule_pack' &&
    draft.content.rules.some(
      ({ status: ruleStatus, parameters, units }) =>
        ruleStatus !== 'confirmed' ||
        Object.entries(parameters ?? {}).some(
          ([key, value]) => typeof value === 'number' && !Object.hasOwn(units ?? {}, key),
        ),
    )
  ) {
    throw new AppError(
      409,
      'KNOWLEDGE_RULES_PENDING',
      '请先确认每条规则，给数值补上单位，再登记新版本。',
    );
  }

  try {
    const {
      rows: [saved],
    } = await db.query<ReviewRow>(
      `UPDATE knowledge_review SET status=$2,reviewer_id=$3,review_session_id=$4,
        decision_request_key=$5,reason=$6,reviewed_at=clock_timestamp()
        WHERE id=$1 RETURNING ${reviewColumns}`,
      [id, status, actor.userId, actor.sessionId, input.requestKey, reason],
    );
    if (status === 'published') await publishDraft(db, draft, id, actor.userId);
    await audit(db, actor.userId, id, `knowledge.review_${status}`, input.contentSha256);
    return summarize(saved!);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505')
      throw conflict();
    throw error;
  }
}

async function publishDraft(db: PoolClient, draft: KnowledgeDraft, id: string, reviewer: string) {
  if (draft.kind === 'template') {
    await db.query('INSERT INTO template(code) VALUES($1) ON CONFLICT(code) DO NOTHING', [
      draft.content.code,
    ]);
    await db.query('SELECT id FROM template WHERE code=$1 FOR UPDATE', [draft.content.code]);
    const existing = await db.query(
      `SELECT 1 FROM template_version v JOIN template t ON t.id=v.template_id
        WHERE t.code=$1 AND string_to_array(v.version,'.')::int[] >= string_to_array($2,'.')::int[] LIMIT 1`,
      [draft.content.code, draft.content.version],
    );
    if (existing.rowCount) throw versionNotNewer();
    await db.query(
      `INSERT INTO template_version(template_id,version,content,review_id,published_at)
        SELECT t.id,r.version,r.content,r.id,r.reviewed_at FROM knowledge_review r
        JOIN template t ON t.code=r.code WHERE r.id=$1`,
      [id],
    );
    return;
  }
  const { code, jurisdiction } = draft.content;
  await db.query(
    'INSERT INTO rule_pack(code,jurisdiction) VALUES($1,$2) ON CONFLICT(code) DO NOTHING',
    [code, jurisdiction],
  );
  const match = await db.query(
    'SELECT id FROM rule_pack WHERE code=$1 AND jurisdiction=$2 FOR UPDATE',
    [code, jurisdiction],
  );
  if (!match.rowCount)
    throw new AppError(
      409,
      'RULE_PACK_SCOPE_CHANGED',
      '这个规则包已登记在不同市场，请核对包编号。',
    );
  const existing = await db.query(
    `SELECT 1 FROM rule_pack_version v JOIN rule_pack p ON p.id=v.pack_id
      WHERE p.code=$1 AND v.publication='published' AND v.review_id IS NOT NULL
        AND string_to_array(v.version,'.')::int[] >= string_to_array($2,'.')::int[] LIMIT 1`,
    [code, draft.content.version],
  );
  if (existing.rowCount) throw versionNotNewer();
  await db.query(
    `INSERT INTO rule_pack_version(pack_id,version,content,publication,published_by,review_id,published_at)
      SELECT p.id,r.version,r.content,'published',$2,r.id,r.reviewed_at FROM knowledge_review r
      JOIN rule_pack p ON p.code=r.code WHERE r.id=$1`,
    [id, reviewer],
  );
}

function audit(db: PoolClient, userId: string, id: string, action: string, hash: string) {
  return db.query(
    `INSERT INTO audit_log(actor_user_id,actor_kind,action,target_type,target_id,after_hash)
      VALUES($1,'browser',$2,'knowledge_review',$3,$4)`,
    [userId, action, id, hash],
  );
}

export async function readPublishedTemplate(ctx: ToolExecutionContext, code: string) {
  const {
    rows: [row],
  } = await ctx.tx.query<{ id: string; content: unknown }>(
    `SELECT v.id,v.content FROM template t JOIN template_version v ON v.template_id=t.id
      WHERE t.code=$1 ORDER BY split_part(v.version,'.',1)::int DESC,
        split_part(v.version,'.',2)::int DESC,split_part(v.version,'.',3)::int DESC,v.id
      LIMIT 1`,
    [code],
  );
  const template = row
    ? publishedTemplateSchema.parse({
        ...templateSeedSchema.parse(row.content),
        versionId: row.id,
        publication: 'published',
      })
    : null;
  return {
    data: { kind: 'template' as const, template },
    dataLevel: template?.dataLevel ?? 'internal',
  };
}
