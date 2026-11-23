import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  agentSkillIndexSchema,
  browserIdentitySchema,
  skillActionResultSchema,
  skillActionSchema,
  skillLoadInputSchema,
  skillLoadResultSchema,
  skillPageSchema,
  skillParamsSchema,
  skillVersionDraftSchema,
  skillVersionViewSchema,
  skillViewSchema,
  type AgentCode,
  type BrowserIdentity,
  type PermissionMode,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';

type Db = Pick<PoolClient, 'query'>;
type Skill = { id: string; agentCode: AgentCode; revision: number };
type Version = {
  id: string;
  metadata: unknown;
  body: string;
  contentSha256: string;
  published: boolean;
};
type Release = {
  skillId: string;
  revision: number;
  targetVersionId: string;
  activeVersionId: string | null;
  fingerprint: string;
  createdAt: Date;
};
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const missing = () =>
  new AppError(404, 'SKILL_UNAVAILABLE', '当前 Agent 没有可加载的指定版本，请核对有效技能索引。');
const stale = () =>
  new AppError(409, 'SKILL_VERSION_CONFLICT', '技能版本状态已改变，请刷新审核卡后重新确认。');

export async function withSkillTransaction<T>(pool: Pool, work: (db: PoolClient) => Promise<T>) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await work(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

const skillColumns = 'id,agent_code AS "agentCode",revision';
const versionColumns = `v.id,v.metadata,v.body,v.content_sha256 AS "contentSha256",EXISTS(
  SELECT 1 FROM skill_release h WHERE h.skill_id=v.skill_id AND h.target_version_id=v.id AND h.action='publish'
) AS published`;
const releaseColumns = `skill_id AS "skillId",revision,target_version_id AS "targetVersionId",
active_version_id AS "activeVersionId",fingerprint,created_at AS "createdAt"`;
const catalogLimit = 60;

function readableSkill({ metadata, body }: ReturnType<typeof skillVersionDraftSchema.parse>) {
  const { id, version, name, summary } = agentSkillIndexSchema.parse({
    id: metadata.id,
    version: metadata.version,
    name: metadata.name,
    summary: metadata.summary,
  });
  const loaded = skillLoadResultSchema.safeParse({
    skill: { id, version, name, summary, agentCode: metadata.agentCode },
    body,
    attachments: [],
    publication: 'published',
    developmentOnly: false,
    reviewPolicy: {
      skill: { id, version },
      publication: 'published',
      developmentOnly: false,
      requiredChecks: metadata.requiredChecks,
      minimumEvidence: metadata.minimumEvidence,
      risk: metadata.risk,
      cardType: 'finalize',
    },
  });
  if (!loaded.success)
    throw new AppError(
      422,
      'SKILL_LOAD_LIMIT',
      '此版本完整加载后的技能回执超出上限，请缩短正文或示例后登记新版本。',
    );
  return loaded.data;
}

async function revision(db: Db, id: string, lock: 'read' | 'write' | 'none' = 'none') {
  const locking = { read: ' FOR SHARE', write: ' FOR UPDATE', none: '' }[lock];
  return (await db.query<Skill>(`SELECT ${skillColumns} FROM skill WHERE id=$1${locking}`, [id]))
    .rows[0];
}
async function activeRelease(db: Db, id: string) {
  return (
    await db.query<Release>(
      `SELECT ${releaseColumns} FROM skill_release WHERE skill_id=$1 ORDER BY revision DESC LIMIT 1`,
      [id],
    )
  ).rows[0];
}
async function previousVersion(db: Db, id: string, from: string | undefined) {
  if (!from) return null;
  const row = (
    await db.query<{ version: string }>(
      `WITH eligible AS (
      SELECT target_version_id,min(revision) AS original_revision FROM skill_release
      WHERE skill_id=$1 AND action='publish' GROUP BY target_version_id
    ) SELECT target_version_id AS version FROM eligible WHERE original_revision <
      (SELECT original_revision FROM eligible WHERE target_version_id=$2)
    ORDER BY original_revision DESC LIMIT 1`,
      [id, from],
    )
  ).rows[0];
  return row?.version ?? null;
}

export async function lockSkillHistory(db: PoolClient, id: string) {
  const base = await revision(db, id, 'write');
  if (!base) return null;
  const release = await activeRelease(db, id);
  if (!release?.activeVersionId || release.revision !== base.revision) return null;
  return {
    activeVersionId: release.activeVersionId,
    previousVersionId: await previousVersion(db, id, release.targetVersionId),
    revision: release.revision,
    publishedAt: release.createdAt,
  };
}

export async function stageSkillVersion(pool: Pool, input: unknown) {
  const parsed = skillVersionDraftSchema.safeParse(input);
  if (
    !parsed.success ||
    !parsed.data.body.trim() ||
    /\0|[\uD800-\uDFFF]/u.test(parsed.data.body) ||
    Buffer.byteLength(parsed.data.body, 'utf8') > 32_000
  )
    throw new AppError(
      422,
      'SKILL_DRAFT_INVALID',
      '技能内容或元数据不符合 SKILL.md 约定，请补齐必填字段和检查项。',
    );
  const { metadata, body } = parsed.data;
  readableSkill(parsed.data);
  const fingerprint = sha(parsed.data);
  return withSkillTransaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['skill-catalog']);
    const state = (
      await db.query<{ count: number; existing: boolean }>(
        'SELECT count(*)::int AS count,COALESCE(bool_or(id=$1),false) AS existing FROM skill',
        [metadata.id],
      )
    ).rows[0]!;
    if (!state.existing && state.count >= catalogLimit)
      throw new AppError(
        413,
        'SKILL_CATALOG_LIMIT',
        `技能目录已达 ${catalogLimit} 项，请联系维护人员增加分页。`,
      );
    await db.query('INSERT INTO skill(id,agent_code) VALUES($1,$2) ON CONFLICT DO NOTHING', [
      metadata.id,
      metadata.agentCode,
    ]);
    const base = await revision(db, metadata.id, 'write');
    if (!base || base.agentCode !== metadata.agentCode) throw stale();
    const existing = (
      await db.query<Version>(
        `SELECT ${versionColumns} FROM skill_version v WHERE v.skill_id=$1 AND v.version=$2`,
        [metadata.id, metadata.version],
      )
    ).rows[0];
    if (existing) {
      if (existing.contentSha256 !== fingerprint) throw stale();
      return { id: existing.id, contentSha256: fingerprint, created: false };
    }
    const count =
      (
        await db.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM skill_version WHERE skill_id=$1',
          [metadata.id],
        )
      ).rows[0]?.count ?? 0;
    if (count >= 60)
      throw new AppError(
        413,
        'SKILL_VERSION_LIMIT',
        '该技能已有 60 个版本，请联系维护人员增加版本分页。',
      );
    const created = await db.query<{ id: string }>(
      `INSERT INTO skill_version(skill_id,version,metadata,body,content_sha256) VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [metadata.id, metadata.version, metadata, body, fingerprint],
    );
    return { id: created.rows[0]!.id, contentSha256: fingerprint, created: true };
  });
}

export async function readSkillVersion(db: Db, id: string, versionId: string) {
  const value = (
    await db.query<Version>(
      `SELECT ${versionColumns} FROM skill_version v WHERE v.skill_id=$1 AND v.id=$2`,
      [id, versionId],
    )
  ).rows[0];
  if (!value) throw missing();
  const version = skillVersionViewSchema.parse(value);
  if (sha({ metadata: version.metadata, body: version.body }) !== version.contentSha256)
    throw new AppError(
      409,
      'SKILL_CONTENT_CONFLICT',
      '登记的技能内容哈希不匹配，请联系维护人员核对。',
    );
  return version;
}

export async function listSkillVersions(db: Db) {
  const rows = await db.query<Skill>(
    `SELECT ${skillColumns} FROM skill ORDER BY agent_code,id LIMIT 60`,
  );
  const items = [];
  for (const row of rows.rows) {
    const active = await activeRelease(db, row.id);
    const all = await db.query<Version>(
      `SELECT ${versionColumns} FROM skill_version v WHERE v.skill_id=$1 ORDER BY v.created_at DESC,v.id DESC LIMIT 60`,
      [row.id],
    );
    const versions = all.rows.map(({ body: _body, ...rest }) => rest);
    items.push(
      skillViewSchema.parse({
        ...row,
        revision: active?.revision ?? 0,
        activeVersionId: active?.activeVersionId ?? null,
        previousVersionId: await previousVersion(db, row.id, active?.targetVersionId),
        versions,
      }),
    );
  }
  return skillPageSchema.parse({ items });
}

export async function decideSkillVersion(
  pool: Pool,
  actorInput: unknown,
  id: string,
  input: unknown,
) {
  return withSkillTransaction(pool, (db) => decideSkillVersionTx(db, actorInput, id, input));
}

export async function requireSkillBrowserSession(db: PoolClient, actor: BrowserIdentity) {
  const valid = await db.query(
    `SELECT s.id FROM web_session s JOIN app_user u ON u.id=s.user_id
    WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
    AND u.status='active' FOR SHARE OF s,u`,
    [actor.sessionId, actor.userId],
  );
  if (!valid.rowCount)
    throw new AppError(403, 'SKILL_BROWSER_REQUIRED', '浏览器会话已失效，请重新登录后审核。');
}

export async function decideSkillVersionTx(
  db: PoolClient,
  actorInput: unknown,
  id: string,
  input: unknown,
) {
  const actor = browserIdentitySchema.safeParse(actorInput);
  const body = skillActionSchema.safeParse(input);
  if (!actor.success)
    throw new AppError(
      403,
      'SKILL_BROWSER_REQUIRED',
      '只有已登录的注册人员可以在浏览器审核技能版本。',
    );
  if (!body.success || !skillParamsSchema.safeParse({ id }).success) throw stale();
  const command = body.data;
  const fingerprint = sha({ ...command, skillId: id, userId: actor.data.userId });
  await requireSkillBrowserSession(db, actor.data);
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `skill-release:${command.requestKey}`,
  ]);
  const replay = (
    await db.query<Release>(`SELECT ${releaseColumns} FROM skill_release WHERE request_key=$1`, [
      command.requestKey,
    ])
  ).rows[0];
  if (replay) {
    if (replay.fingerprint !== fingerprint) throw stale();
    return skillActionResultSchema.parse({
      skillId: id,
      revision: replay.revision,
      activeVersionId: replay.activeVersionId,
      replayed: true,
    });
  }
  const base = await revision(db, id, 'write');
  if (!base || base.revision !== command.expectedRevision) throw stale();
  const active = await activeRelease(db, id);
  if ((active?.revision ?? 0) !== base.revision) throw stale();
  const target = await readSkillVersion(db, id, command.versionId);
  if (target.contentSha256 !== command.contentSha256) throw stale();
  if (command.action !== 'disable') readableSkill(target);
  if (command.action === 'disable' && active?.activeVersionId !== target.id) throw stale();
  if (
    command.action === 'rollback' &&
    (await previousVersion(db, id, active?.targetVersionId)) !== target.id
  )
    throw stale();

  const activated = command.action === 'disable' ? null : target.id;
  const before = active?.activeVersionId
    ? await readSkillVersion(db, id, active.activeVersionId)
    : null;
  const next = base.revision + 1;
  await db.query(
    `INSERT INTO skill_release(skill_id,revision,action,target_version_id,active_version_id,actor_user_id,request_key,fingerprint)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      next,
      command.action,
      target.id,
      activated,
      actor.data.userId,
      command.requestKey,
      fingerprint,
    ],
  );
  await db.query('UPDATE skill SET revision=$2 WHERE id=$1', [id, next]);
  await db.query(
    `INSERT INTO audit_log(actor_user_id,actor_kind,action,target_type,target_id,before_hash,after_hash)
      VALUES($1,'browser',$2,'skill',$3,$4,$5)`,
    [
      actor.data.userId,
      `skill.${command.action}`,
      id,
      before?.contentSha256 ?? null,
      activated ? target.contentSha256 : null,
    ],
  );
  return skillActionResultSchema.parse({
    skillId: id,
    revision: next,
    activeVersionId: activated,
    replayed: false,
  });
}

export async function readActiveSkill(
  db: Db,
  code: AgentCode,
  input: unknown,
  mode?: PermissionMode,
) {
  const request = skillLoadInputSchema.parse(input);
  const entry = await revision(db, request.id, 'read');
  if (!entry) return undefined;
  if (entry.agentCode !== code) return null;
  const active = await activeRelease(db, request.id);
  if (!active) return undefined;
  if (!active.activeVersionId) return null;
  const current = await readSkillVersion(db, request.id, active.activeVersionId);
  if (
    !current.published ||
    current.metadata.agentCode !== code ||
    (request.version && request.version !== current.metadata.version) ||
    (mode && !current.metadata.modes.includes(mode))
  )
    return null;
  return readableSkill(current);
}

export async function registeredSkillIds(db: Db, code: AgentCode) {
  return (
    await db.query<{ id: string }>(
      'SELECT id FROM skill WHERE agent_code=$1 ORDER BY id LIMIT 60',
      [code],
    )
  ).rows.map(({ id }) => id);
}
