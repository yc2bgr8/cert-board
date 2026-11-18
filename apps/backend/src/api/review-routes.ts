import { createHash } from 'node:crypto';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyRequest,
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
} from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  browserIdentitySchema,
  structuredSubmissionSchema,
  checkReportSchema,
  reviewDiffSchema,
  reviewEvidenceRefSchema,
  reviewParamsSchema,
  reviewCardViewSchema,
  reviewDecisionInputSchema,
  reviewDecisionResultSchema,
  reviewJudgmentInputSchema,
  reviewJudgmentResultSchema,
  type BackendConfig,
  type BrowserIdentity,
} from '@cert-board/shared';
import { requireBrowserIdentity } from '../auth/session.js';
import { authorize } from '../auth/authorization.js';
import { reviewContentHash } from '../reviews/content.js';
import { AppError } from './errors.js';

type Card = {
  id: string;
  project_id: string;
  goal_id: string;
  conversation_id: string;
  run_id: string;
  created_by: string;
  workspace_version_id: string;
  skill_id: string;
  skill_version: string;
  risk: 'standard' | 'high';
  card_type: 'finalize';
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  version: number;
  content_hash: string;
  structured_result: unknown;
  check_report: unknown;
  diff: unknown;
  evidence_refs: unknown;
  created_at: Date;
  decided_at: Date | null;
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function registerReviewRoutes<Logger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    Logger
  >,
  pool: Pool,
  config: BackendConfig,
) {
  const missing = () =>
    new AppError(404, 'REVIEW_NOT_FOUND', '没有找到可访问的审核卡，请从当前项目重新打开。');
  const conflict = (message: string) => new AppError(409, 'REVIEW_VERSION_CONFLICT', message);
  const id = (request: FastifyRequest) => {
    const parsed = reviewParamsSchema.safeParse(request.params);
    if (!parsed.success)
      throw new AppError(400, 'REVIEW_ID_INVALID', '审核卡编号无效，请重新打开。');
    return parsed.data.id;
  };
  // 人的判断和决定始终从真实浏览器请求进入；不导出接受Agent身份的审批函数。
  const browserTransaction = async <T>(
    request: FastifyRequest,
    write: boolean,
    operation: (tx: PoolClient, actor: BrowserIdentity) => Promise<T>,
  ) => {
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      const first = await requireBrowserIdentity(request, tx, config, { write });
      const session = await tx.query(
        `SELECT s.id FROM web_session s JOIN app_user u ON u.id=s.user_id
        WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>CURRENT_TIMESTAMP AND u.status='active' FOR SHARE OF s,u`,
        [first.sessionId, first.userId],
      );
      if (!session.rowCount) throw new AppError(401, 'LOGIN_REQUIRED', '登录已失效，请重新登录。');
      const checked = await requireBrowserIdentity(request, tx, config, { write });
      const roles = await tx.query(
        'SELECT role,scope_type AS "scopeType",scope_id AS "scopeId" FROM role_binding WHERE user_id=$1 FOR SHARE',
        [checked.userId],
      );
      const permittedRoles = roles.rows.filter(
        (binding) => binding.role === 'RA' || binding.role === 'RB',
      );
      if (!permittedRoles.length)
        throw new AppError(403, 'REVIEW_ROLE_REQUIRED', '此审核卡需要注册审核权限。');
      const actor = browserIdentitySchema.parse({
        ...checked,
        roles: permittedRoles,
      });
      const result = await operation(tx, actor);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError(
        500,
        'REVIEW_TRANSACTION_FAILED',
        '审核记录处理未完成，请刷新后核对；未输出内部内容。',
      );
    } finally {
      tx.release();
    }
  };
  const authorized = async (tx: PoolClient, actor: BrowserIdentity, card: Card, lock = false) => {
    const project = await tx.query<{ owner_user_id: string }>(
      `SELECT owner_user_id FROM cert_project WHERE id=$1${lock ? ' FOR SHARE' : ''}`,
      [card.project_id],
    );
    if (
      !project.rows[0] ||
      !authorize(actor, 'review.decide', {
        projectId: card.project_id,
        ownerUserId: project.rows[0].owner_user_id,
        reviewKind: 'registration',
      })
    )
      throw missing();
  };
  const load = async (tx: PoolClient, actor: BrowserIdentity, cardId: string, write: boolean) => {
    const initial = (await tx.query<Card>('SELECT * FROM review_card WHERE id=$1', [cardId]))
      .rows[0];
    if (!initial) throw missing();
    await authorized(tx, actor, initial);
    const workspace = (
      await tx.query<{ id: string; current_version_id: string | null }>(
        `SELECT id,current_version_id FROM workspace WHERE project_id=$1${write ? ' FOR UPDATE' : ''}`,
        [initial.project_id],
      )
    ).rows[0];
    const goal = (
      await tx.query<{ status: string; direction_version: number; project_id: string }>(
        `SELECT status,direction_version,project_id FROM goal WHERE id=$1${write ? ' FOR UPDATE' : ''}`,
        [initial.goal_id],
      )
    ).rows[0];
    if (!workspace || !goal || goal.project_id !== initial.project_id) throw missing();
    if (write) {
      const conversation = await tx.query(
        'SELECT id FROM conversation WHERE id=$1 AND project_id=$2 AND user_id=$3 FOR UPDATE',
        [initial.conversation_id, initial.project_id, initial.created_by],
      );
      if (!conversation.rowCount) throw missing();
    }
    const run = (
      await tx.query<{ direction_version: number }>(
        `SELECT direction_version FROM run WHERE id=$1 AND conversation_id=$2 AND user_id=$3${write ? ' FOR UPDATE' : ''}`,
        [initial.run_id, initial.conversation_id, initial.created_by],
      )
    ).rows[0];
    const card = write
      ? (await tx.query<Card>('SELECT * FROM review_card WHERE id=$1 FOR UPDATE', [cardId])).rows[0]
      : initial;
    if (!card || !run) throw missing();
    if (write) await authorized(tx, actor, card, true);
    return { card, workspace, goal, run };
  };
  const content = (card: Card) => {
    const payload = {
      submission: structuredSubmissionSchema.parse(card.structured_result),
      checks: checkReportSchema.parse(card.check_report),
      diff: reviewDiffSchema.parse(card.diff),
      evidenceRefs: z.array(reviewEvidenceRefSchema).max(40).parse(card.evidence_refs),
      risk: card.risk,
      cardType: card.card_type,
    };
    if (
      payload.submission.workspaceVersion !== card.workspace_version_id ||
      payload.submission.skill.id !== card.skill_id ||
      payload.submission.skill.version !== card.skill_version ||
      !payload.checks.passed ||
      reviewContentHash(payload) !== card.content_hash
    )
      throw new AppError(
        409,
        'REVIEW_CONTENT_MISMATCH',
        '审核卡内容校验失败，请重新提交，不要批准旧卡片。',
      );
    return payload;
  };
  const sources = async (
    tx: PoolClient,
    actor: BrowserIdentity,
    card: Card,
    payload: ReturnType<typeof content>,
  ) => {
    const refs = [
      ...payload.submission.evidence,
      ...payload.submission.claims.flatMap((claim) => claim.sources),
    ];
    const seen = new Set<string>();
    for (const ref of refs) {
      const key = `${ref.documentId}:${ref.version}:${ref.page}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const found = await tx.query<{ owner_user_id: string }>(
        `SELECT d.owner_user_id FROM document d
        JOIN document_version v ON v.document_id=d.id JOIN document_page p ON p.version_id=v.id
        WHERE d.id=$1 AND d.project_id=$2 AND NOT d.voided AND v.version_no=$3 AND p.page_number=$4 AND NOT p.is_placeholder FOR SHARE OF d`,
        [ref.documentId, card.project_id, ref.version, ref.page],
      );
      if (
        !found.rows[0] ||
        !authorize(actor, 'document.read', {
          projectId: card.project_id,
          ownerUserId: found.rows[0].owner_user_id,
        })
      )
        throw new AppError(
          403,
          'REVIEW_SOURCE_UNAVAILABLE',
          '审核引用的有效资料已不可访问，请重新核查后提交。',
        );
    }
  };
  const judgment = async (tx: PoolClient, actor: BrowserIdentity, card: Card) => {
    const row = (
      await tx.query<{ statement: string; created_at: Date }>(
        'SELECT statement,created_at FROM review_judgment WHERE card_id=$1 AND actor_user_id=$2 AND content_hash=$3',
        [card.id, actor.userId, card.content_hash],
      )
    ).rows[0];
    return row ? { statement: row.statement, createdAt: row.created_at.toISOString() } : null;
  };
  const common = (card: Card) => ({
    id: card.id,
    projectId: card.project_id,
    goalId: card.goal_id,
    conversationId: card.conversation_id,
    workspaceVersion: card.workspace_version_id,
    skill: { id: card.skill_id, version: card.skill_version },
    risk: card.risk,
    cardType: card.card_type,
    status: card.status,
    version: card.version,
    createdAt: card.created_at.toISOString(),
    decidedAt: card.decided_at?.toISOString() ?? null,
  });

  app.get('/api/reviews/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return browserTransaction(request, false, async (tx, actor) => {
      const { card } = await load(tx, actor, id(request), false);
      const ownJudgment = await judgment(tx, actor, card);
      if (card.risk === 'high' && !ownJudgment)
        return reviewCardViewSchema.parse({ ...common(card), requiresJudgment: true });
      const payload = content(card);
      await sources(tx, actor, card, payload);
      const previous = (
        await tx.query<{
          id: string;
          action: string;
          reason: string | null;
          actor_user_id: string;
          created_at: Date;
          snapshot_id: string | null;
        }>(
          'SELECT id,action,reason,actor_user_id,created_at,snapshot_id FROM review_decision WHERE card_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',
          [card.id],
        )
      ).rows[0];
      return reviewCardViewSchema.parse({
        ...common(card),
        requiresJudgment: false,
        submission: payload.submission,
        checks: payload.checks,
        diff: payload.diff,
        evidenceRefs: payload.evidenceRefs,
        judgment: ownJudgment,
        decision: previous
          ? {
              id: previous.id,
              action: previous.action,
              reason: previous.reason,
              actorUserId: previous.actor_user_id,
              createdAt: previous.created_at.toISOString(),
              snapshotId: previous.snapshot_id,
            }
          : null,
      });
    });
  });
  app.post('/api/reviews/:id/judgment', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return browserTransaction(request, true, async (tx, actor) => {
      const parsed = reviewJudgmentInputSchema.safeParse(request.body);
      if (!parsed.success)
        throw new AppError(400, 'REVIEW_JUDGMENT_INVALID', '请填写独立判断并使用当前卡片版本。');
      const input = parsed.data;
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `review-judgment:${actor.userId}:${input.requestKey}`,
      ]);
      const { card } = await load(tx, actor, id(request), true);
      const prior = (
        await tx.query<{
          id: string;
          card_id: string;
          source_version: number;
          content_hash: string;
          statement: string;
        }>(
          'SELECT id,card_id,source_version,content_hash,statement FROM review_judgment WHERE actor_user_id=$1 AND request_key=$2',
          [actor.userId, input.requestKey],
        )
      ).rows[0];
      if (prior) {
        if (
          prior.card_id !== card.id ||
          prior.source_version !== input.expectedVersion ||
          prior.content_hash !== card.content_hash ||
          prior.statement !== input.statement
        )
          throw conflict('同一判断请求的卡片、版本或文字改变，请刷新后使用新请求编号。');
        return reviewJudgmentResultSchema.parse({
          cardId: card.id,
          judgmentId: prior.id,
          recorded: true,
          replayed: true,
        });
      }
      if (card.version !== input.expectedVersion)
        throw conflict('审核卡版本已变化，请刷新后重新填写判断。');
      const payload = content(card);
      await sources(tx, actor, card, payload);
      const existing = (
        await tx.query<{ id: string; statement: string }>(
          'SELECT id,statement FROM review_judgment WHERE card_id=$1 AND actor_user_id=$2 AND content_hash=$3',
          [card.id, actor.userId, card.content_hash],
        )
      ).rows[0];
      if (existing) {
        if (existing.statement !== input.statement)
          throw conflict('已有独立判断不可改写；后续想法可写入决定原因或新对话。');
        return reviewJudgmentResultSchema.parse({
          cardId: card.id,
          judgmentId: existing.id,
          recorded: true,
          replayed: true,
        });
      }
      const saved = (
        await tx.query<{ id: string }>(
          `INSERT INTO review_judgment(card_id,actor_user_id,session_id,request_key,source_version,content_hash,statement)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [
            card.id,
            actor.userId,
            actor.sessionId,
            input.requestKey,
            card.version,
            card.content_hash,
            input.statement,
          ],
        )
      ).rows[0]!;
      await tx.query(
        "INSERT INTO audit_log(actor_user_id,actor_kind,action,target_type,target_id,after_hash) VALUES($1,'browser','review.judgment_recorded','review_card',$2,$3)",
        [actor.userId, card.id, hash(input.statement)],
      );
      return reviewJudgmentResultSchema.parse({
        cardId: card.id,
        judgmentId: saved.id,
        recorded: true,
        replayed: false,
      });
    });
  });
  app.post('/api/reviews/:id/decision', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return browserTransaction(request, true, async (tx, actor) => {
      const parsed = reviewDecisionInputSchema.safeParse(request.body);
      if (!parsed.success)
        throw new AppError(
          400,
          'REVIEW_DECISION_INVALID',
          '请使用当前版本明确通过或退回；退回时必须填写原因。',
        );
      const input = parsed.data;
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `review-decision:${actor.userId}:${input.requestKey}`,
      ]);
      const { card, workspace, goal, run } = await load(tx, actor, id(request), true);
      const previous = (
        await tx.query<{
          id: string;
          card_id: string;
          source_version: number;
          content_hash: string;
          action: 'approved' | 'rejected';
          reason: string | null;
          snapshot_id: string | null;
        }>(
          'SELECT id,card_id,source_version,content_hash,action,reason,snapshot_id FROM review_decision WHERE actor_user_id=$1 AND request_key=$2',
          [actor.userId, input.requestKey],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.card_id !== card.id ||
          previous.source_version !== input.expectedVersion ||
          previous.content_hash !== card.content_hash ||
          previous.action !== input.action ||
          previous.reason !== input.reason ||
          input.workspaceVersion !== card.workspace_version_id
        )
          throw conflict('同一决定请求的卡片、版本或内容已变化，请刷新后使用新请求编号。');
        return reviewDecisionResultSchema.parse({
          cardId: card.id,
          status: previous.action,
          version: card.version,
          decisionId: previous.id,
          snapshotId: previous.snapshot_id,
          replayed: true,
        });
      }
      if (
        card.status !== 'pending' ||
        card.version !== input.expectedVersion ||
        input.workspaceVersion !== card.workspace_version_id ||
        workspace.current_version_id !== card.workspace_version_id
      )
        throw conflict('审核卡或工作区版本已变化，请重新核查并提交，不能批准旧版本。');
      if (goal.status !== 'active' || goal.direction_version !== run.direction_version)
        throw conflict('目标状态或方向已改变，请负责人核对后重新提交审核。');
      if (card.risk === 'high' && !(await judgment(tx, actor, card)))
        throw new AppError(
          403,
          'REVIEW_JUDGMENT_REQUIRED',
          '请先在浏览器填写自己的独立判断，再查看结论和作决定。',
        );
      const payload = content(card);
      await sources(tx, actor, card, payload);
      let snapshotId: string | null = null;
      if (input.action === 'approved') {
        const files = await tx.query<{
          path: string;
          sha256: string;
          byte_size: string;
          data_level: string;
          media_type: string;
        }>(
          'SELECT path,sha256,byte_size,data_level,media_type FROM workspace_file WHERE version_id=$1 ORDER BY path COLLATE "C"',
          [card.workspace_version_id],
        );
        const manifest = files.rows.map((file) => ({
          path: file.path,
          sha256: file.sha256,
          byteSize: Number(file.byte_size),
          dataLevel: file.data_level,
          mediaType: file.media_type,
        }));
        const snapshot = await tx.query<{ id: string }>(
          `INSERT INTO submission_snapshot(project_id,sequence,kind,file_manifest,manifest_sha256,workspace_version_id,created_by)
          VALUES($1,(SELECT COALESCE(MAX(sequence),0)+1 FROM submission_snapshot WHERE project_id=$1),'approved_review',$2,$3,$4,$5) RETURNING id`,
          [
            card.project_id,
            JSON.stringify(manifest),
            hash(manifest),
            card.workspace_version_id,
            actor.userId,
          ],
        );
        snapshotId = snapshot.rows[0]!.id;
      }
      const saved = (
        await tx.query<{ id: string }>(
          `INSERT INTO review_decision(card_id,actor_user_id,session_id,request_key,source_version,content_hash,action,reason,snapshot_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [
            card.id,
            actor.userId,
            actor.sessionId,
            input.requestKey,
            card.version,
            card.content_hash,
            input.action,
            input.reason,
            snapshotId,
          ],
        )
      ).rows[0]!;
      const changed = (
        await tx.query<{ version: number }>(
          'UPDATE review_card SET status=$1,version=version+1,decided_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$2 RETURNING version',
          [input.action, card.id],
        )
      ).rows[0]!;
      // 仅收尾已经暂停的运行；若人工操作快于内核收尾，内核须按最新卡片状态条件更新。
      await tx.query(
        `UPDATE run SET status=$1,finished_at=COALESCE(finished_at,CURRENT_TIMESTAMP),version=version+1,updated_at=CURRENT_TIMESTAMP
        WHERE id=$2 AND status='waiting' AND NOT EXISTS(SELECT 1 FROM review_card WHERE run_id=$2 AND status='pending')`,
        [input.action === 'approved' ? 'completed' : 'stopped', card.run_id],
      );
      await tx.query(
        "INSERT INTO audit_log(actor_user_id,actor_kind,action,target_type,target_id,before_hash,after_hash) VALUES($1,'browser',$2,'review_card',$3,$4,$4)",
        [actor.userId, `review.${input.action}`, card.id, card.content_hash],
      );
      return reviewDecisionResultSchema.parse({
        cardId: card.id,
        status: input.action,
        version: changed.version,
        decisionId: saved.id,
        snapshotId,
        replayed: false,
      });
    });
  });
}
