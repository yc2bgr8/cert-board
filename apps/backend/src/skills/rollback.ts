import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  skillRollbackDecisionResultSchema,
  skillRollbackEvidenceSchema,
  skillRollbackListSchema,
  skillRollbackPolicySchema,
  type BrowserIdentity,
  type SkillRollbackDecisionInput,
  type SkillRollbackPolicyInput,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import {
  decideSkillVersionTx,
  lockSkillHistory,
  readSkillVersion,
  requireSkillBrowserSession,
  withSkillTransaction,
} from './service.js';

type Db = Pick<PoolClient, 'query'>;
type Proposal = {
  id: string;
  skill_id: string;
  active_version_id: string;
  target_version_id: string | null;
  release_revision: number;
  status: string;
  decided_by: string | null;
  request_key: string | null;
};
const unavailable = () =>
  new AppError(409, 'SKILL_ROLLBACK_STALE', '提案或生效版本已变化，请刷新技能审核卡。');
const policyHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function getSkillRollbackPolicy(db: Db) {
  const policy = (
    await db.query(
      `SELECT minimum_cards AS "minimumCards",rejection_percent AS "rejectionPercent",revision
       FROM skill_rollback_policy WHERE id='default'`,
    )
  ).rows[0];
  return skillRollbackPolicySchema.parse(
    policy ?? { minimumCards: 10, rejectionPercent: 50, revision: 0 },
  );
}

export async function saveSkillRollbackPolicy(
  pool: Pool,
  actor: BrowserIdentity,
  input: SkillRollbackPolicyInput,
) {
  return withSkillTransaction(pool, async (db) => {
    await requireSkillBrowserSession(db, actor);
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'skill-rollback-policy',
    ]);
    const prior = await getSkillRollbackPolicy(db);
    if (prior.revision !== input.expectedRevision) throw unavailable();
    const next = {
      minimumCards: input.minimumCards,
      rejectionPercent: input.rejectionPercent,
      revision: prior.revision + 1,
    };
    await db.query(
      `INSERT INTO skill_rollback_policy(id,minimum_cards,rejection_percent,revision)
       VALUES('default',$1,$2,$3) ON CONFLICT(id) DO UPDATE
       SET minimum_cards=EXCLUDED.minimum_cards,rejection_percent=EXCLUDED.rejection_percent,revision=EXCLUDED.revision`,
      [next.minimumCards, next.rejectionPercent, next.revision],
    );
    await db.query(
      `INSERT INTO audit_log(actor_user_id,actor_kind,action,target_type,target_id,before_hash,after_hash)
       VALUES($1,'browser','skill.rollback_policy_updated','skill_rollback_policy','default',$2,$3)`,
      [actor.userId, policyHash(prior), policyHash(next)],
    );
    return next;
  });
}

async function reviewStats(
  db: Db,
  skillId: string,
  version: string,
  sampleSize: number,
  before?: Date,
) {
  const result = await db.query<{
    total: number;
    rejected: number;
    lifetime: number;
    from: Date | null;
    to: Date | null;
    reasons: string[];
  }>(
    `WITH decided AS (
      SELECT d.id,d.action,d.created_at,d.reason,r.data_level
      FROM review_card r JOIN review_decision d ON d.card_id=r.id
      WHERE r.skill_id=$1 AND r.skill_version=$2 AND r.status::text=d.action::text
        AND ($4::timestamptz IS NULL OR d.created_at<$4)
    ), recent AS (
      SELECT * FROM decided ORDER BY created_at DESC,id DESC LIMIT $3
    )
    SELECT count(*)::int AS total,count(*) FILTER(WHERE action='rejected')::int AS rejected,
      (SELECT count(*)::int FROM decided) AS lifetime,
      min(created_at) AS "from",max(created_at) AS "to",
      ARRAY(SELECT reason FROM recent WHERE action='rejected' AND reason IS NOT NULL
        AND data_level='internal' ORDER BY created_at DESC,id DESC LIMIT 3) AS reasons
    FROM recent`,
    [skillId, version, sampleSize, before ?? null],
  );
  return result.rows[0]!;
}

async function versionName(db: Db, id: string) {
  return (
    await db.query<{ version: string }>('SELECT version FROM skill_version WHERE id=$1', [id])
  ).rows[0]?.version;
}

export async function scanSkillRollbackProposals(pool: Pool) {
  const policy = await getSkillRollbackPolicy(pool);
  const sampleSize = Math.max(20, policy.minimumCards);
  const candidates = (
    await pool.query<{ id: string }>('SELECT id FROM skill WHERE revision>0 ORDER BY id LIMIT 60')
  ).rows;
  for (const { id } of candidates) {
    await withSkillTransaction(pool, async (db) => {
      const state = await lockSkillHistory(db, id);
      await db.query(
        `UPDATE skill_rollback_proposal SET status='expired'
         WHERE skill_id=$1 AND status IN ('pending','notice')
         AND release_revision IS DISTINCT FROM $2`,
        [id, state?.revision ?? null],
      );
      if (
        !state ||
        (
          await db.query(
            "SELECT 1 FROM skill_rollback_proposal WHERE skill_id=$1 AND status IN ('pending','notice')",
            [id],
          )
        ).rowCount
      )
        return;
      const activeName = await versionName(db, state.activeVersionId);
      if (!activeName) return;
      const stats = await reviewStats(db, id, activeName, sampleSize);
      if (
        !stats.from ||
        !stats.to ||
        stats.total < policy.minimumCards ||
        stats.rejected * 100 < stats.total * policy.rejectionPercent
      )
        return;
      const dismissed = (
        await db.query<{ dismissed_count: number }>(
          `SELECT dismissed_count FROM skill_rollback_proposal
         WHERE skill_id=$1 AND active_version_id=$2 AND status='dismissed'
         ORDER BY decided_at DESC,id DESC LIMIT 1`,
          [id, state.activeVersionId],
        )
      ).rows[0];
      if (dismissed && stats.lifetime < dismissed.dismissed_count + 10) return;
      const previousName = state.previousVersionId
        ? await versionName(db, state.previousVersionId)
        : undefined;
      const previous = previousName
        ? await reviewStats(db, id, previousName, sampleSize, state.publishedAt)
        : null;
      const evidence = skillRollbackEvidenceSchema.parse({
        total: stats.total,
        rejected: stats.rejected,
        from: stats.from.toISOString(),
        to: stats.to.toISOString(),
        reasons: stats.reasons.map((reason) => Array.from(reason).slice(0, 250).join('')),
        previous: previous?.total ? { total: previous.total, rejected: previous.rejected } : null,
      });
      const status = state.previousVersionId ? 'pending' : 'notice';
      const created = (
        await db.query<{ id: string }>(
          `INSERT INTO skill_rollback_proposal(skill_id,active_version_id,target_version_id,release_revision,evidence,status)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,
          [
            id,
            state.activeVersionId,
            state.previousVersionId,
            state.revision,
            JSON.stringify(evidence),
            status,
          ],
        )
      ).rows[0];
      if (created)
        await db.query(
          "INSERT INTO audit_log(actor_kind,action,target_type,target_id) VALUES('system',$1,'skill_rollback_proposal',$2)",
          [
            status === 'pending' ? 'skill.rollback_proposed' : 'skill.rollback_unavailable',
            created.id,
          ],
        );
    });
  }
}

export async function listSkillRollbackProposals(db: Db) {
  const rows = (
    await db.query<{
      id: string;
      skillId: string;
      activeVersion: string;
      previousVersion: string | null;
      status: string;
      releaseRevision: number;
      evidence: unknown;
      createdAt: Date;
    }>(
      `SELECT p.id,p.skill_id AS "skillId",current.version AS "activeVersion",older.version AS "previousVersion",
       p.status,p.release_revision AS "releaseRevision",p.evidence,p.created_at AS "createdAt"
     FROM skill_rollback_proposal p JOIN skill s ON s.id=p.skill_id AND s.revision=p.release_revision
     JOIN skill_version current ON current.id=p.active_version_id
     LEFT JOIN skill_version older ON older.id=p.target_version_id
     WHERE p.status IN ('pending','notice') ORDER BY p.created_at DESC,p.id LIMIT 60`,
    )
  ).rows;
  return skillRollbackListSchema.parse({
    items: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
  });
}

export async function decideSkillRollbackProposal(
  pool: Pool,
  actor: BrowserIdentity,
  proposalId: string,
  input: SkillRollbackDecisionInput,
) {
  return withSkillTransaction(pool, async (db) => {
    await requireSkillBrowserSession(db, actor);
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `skill-release:${input.requestKey}`,
    ]);
    const located = (
      await db.query<{ skill_id: string }>(
        'SELECT skill_id FROM skill_rollback_proposal WHERE id=$1',
        [proposalId],
      )
    ).rows[0];
    if (!located) throw unavailable();
    const state = await lockSkillHistory(db, located.skill_id);
    const proposal = (
      await db.query<Proposal>('SELECT * FROM skill_rollback_proposal WHERE id=$1 FOR UPDATE', [
        proposalId,
      ])
    ).rows[0];
    if (!proposal || proposal.release_revision !== input.expectedRevision) throw unavailable();
    const status = input.action === 'approve' ? 'approved' : 'dismissed';
    if (
      proposal.request_key === input.requestKey &&
      proposal.decided_by === actor.userId &&
      proposal.status === status
    )
      return skillRollbackDecisionResultSchema.parse({ proposalId, status, replayed: true });
    if (
      !state ||
      state.revision !== proposal.release_revision ||
      state.activeVersionId !== proposal.active_version_id ||
      !['pending', 'notice'].includes(proposal.status)
    )
      throw unavailable();
    const used = await db.query('SELECT id FROM skill_rollback_proposal WHERE request_key=$1', [
      input.requestKey,
    ]);
    if (used.rowCount) throw unavailable();
    let dismissedCount: number | null = null;
    if (input.action === 'approve') {
      if (!proposal.target_version_id || proposal.target_version_id !== state.previousVersionId)
        throw unavailable();
      const target = await readSkillVersion(db, proposal.skill_id, proposal.target_version_id);
      await decideSkillVersionTx(db, actor, proposal.skill_id, {
        action: 'rollback',
        expectedRevision: input.expectedRevision,
        versionId: target.id,
        contentSha256: target.contentSha256,
        requestKey: input.requestKey,
      });
    } else {
      const version = await versionName(db, proposal.active_version_id);
      if (!version) throw unavailable();
      dismissedCount = (await reviewStats(db, proposal.skill_id, version, 1)).lifetime;
    }
    await db.query(
      `UPDATE skill_rollback_proposal SET status=$2,request_key=$3,decided_by=$4,session_id=$5,
        dismissed_count=$6,decided_at=clock_timestamp() WHERE id=$1`,
      [proposalId, status, input.requestKey, actor.userId, actor.sessionId, dismissedCount],
    );
    await db.query(
      "INSERT INTO audit_log(actor_user_id,actor_kind,action,target_type,target_id) VALUES($1,'browser',$2,'skill_rollback_proposal',$3)",
      [actor.userId, `skill.rollback_proposal_${status}`, proposalId],
    );
    return skillRollbackDecisionResultSchema.parse({ proposalId, status, replayed: false });
  });
}
