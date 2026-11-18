import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  serviceIdentitySchema,
  expectedVersionSchema,
  goalRecordSchema,
  projectCreateSchema,
  projectIdSchema,
  projectListOptionsSchema,
  projectPatchSchema,
  projectRecordSchema,
  type ServiceIdentity,
} from '@cert-board/shared';
import { authorize } from '../auth/authorization.js';
import { currentServiceIdentity } from '../auth/member.js';
import { AppError } from '../api/errors.js';

type Executor = Pick<Pool, 'query'>;
type Pagination = { cursor?: string; limit?: number };
const projectFields = `p.id, p.code, p.name, p.project_type AS "projectType", p.market, p.pathway,
  p.model_id AS "modelId", p.owner_user_id AS "ownerUserId", p.reviewer_user_id AS "reviewerUserId",
  p.applicant_entity_id AS "applicantEntityId", p.holder_entity_id AS "holderEntityId",
  p.target_at AS "targetAt", p.jurisdiction_tz AS "jurisdictionTz", p.status,
  p.submission_number AS "submissionNumber", p.submitted_at AS "submittedAt", p.accepted_at AS "acceptedAt",
  p.next_action AS "nextAction", p.version, p.created_at AS "createdAt", p.updated_at AS "updatedAt"`;
const goalFields = `g.id, g.project_id AS "projectId", g.owner_user_id AS "ownerUserId", g.title,
  g.acceptance_criteria AS "acceptanceCriteria", g.due_at AS "dueAt", g.budget_usd AS "budgetUsd",
  g.status, g.direction_version AS "directionVersion", g.version,
  g.created_at AS "createdAt", g.updated_at AS "updatedAt"`;

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
function projectRecord(row: Record<string, unknown>) {
  return projectRecordSchema.parse({
    ...row,
    targetAt: iso(row.targetAt),
    submittedAt: iso(row.submittedAt),
    acceptedAt: iso(row.acceptedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}
const missingProject = () =>
  new AppError(404, 'PROJECT_NOT_FOUND', '没有找到可访问的项目，请确认项目或联系负责人。');
const forbidden = () =>
  new AppError(403, 'PROJECT_FORBIDDEN', '当前身份没有执行此项目操作的权限。');

function actor(value: ServiceIdentity) {
  const result = serviceIdentitySchema.safeParse(value);
  if (!result.success) throw forbidden();
  return result.data;
}
function identifier(id: string) {
  const result = projectIdSchema.safeParse(id);
  if (!result.success)
    throw new AppError(400, 'PROJECT_ID_INVALID', '项目编号无效，请从项目列表重新打开。');
  return result.data;
}
function pagination(options: Pagination) {
  const result = projectListOptionsSchema.safeParse(options);
  if (!result.success)
    throw new AppError(
      400,
      'PAGINATION_INVALID',
      '分页参数无效，请使用返回的续读位置，每页最多50条。',
    );
  return { cursor: result.data.cursor ?? null, limit: result.data.limit ?? 50 };
}

export async function listProjects(
  pool: Pool,
  identity: ServiceIdentity,
  options: Pagination = {},
) {
  const viewer = await currentServiceIdentity(pool, identity);
  const page = pagination(options);
  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${projectFields} FROM cert_project p
     WHERE EXISTS(SELECT 1 FROM app_user viewer WHERE viewer.id=$1 AND viewer.status='active')
     AND ($2::uuid IS NULL OR p.id > $2::uuid) ORDER BY p.id ASC LIMIT $3`,
    [viewer.userId, page.cursor, page.limit + 1],
  );
  const hasMore = result.rows.length > page.limit;
  const items = result.rows.slice(0, page.limit).map(projectRecord);
  return { items, hasMore, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
}

async function readProject(
  database: Executor,
  identity: ServiceIdentity,
  id: string,
  write = false,
) {
  const result = await database.query<Record<string, unknown>>(
    `SELECT ${projectFields} FROM cert_project p WHERE EXISTS(SELECT 1 FROM app_user viewer WHERE viewer.id=$1 AND viewer.status='active')
     AND p.id = $2::uuid${write ? ' FOR UPDATE OF p' : ''}`,
    [identity.userId, id],
  );
  if (!result.rows[0]) throw missingProject();
  const record = projectRecord(result.rows[0]);
  if (
    !authorize(identity, write ? 'project.write' : 'project.read', {
      projectId: record.id,
      ownerUserId: record.ownerUserId,
    })
  )
    throw missingProject();
  return record;
}

export async function getProject(pool: Executor, identity: ServiceIdentity, id: string) {
  return readProject(pool, await currentServiceIdentity(pool, identity), identifier(id));
}

async function activeActor(client: PoolClient, identity: ServiceIdentity) {
  const result = await client.query(
    "SELECT id FROM app_user WHERE id = $1 AND status = 'active' FOR SHARE",
    [identity.userId],
  );
  if (!result.rowCount) throw forbidden();
}

async function reviewerAllowed(client: PoolClient, reviewerId: string | null) {
  if (reviewerId === null) return;
  const result = await client.query(
    "SELECT id FROM app_user WHERE id=$1 AND status='active' FOR SHARE",
    [reviewerId],
  );
  if (!result.rowCount)
    throw new AppError(400, 'REVIEWER_INVALID', '所选复核人不是有效部门成员，请重新选择或留空。');
}

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function auditProject(
  client: PoolClient,
  identity: ServiceIdentity,
  action: string,
  id: string,
  before: unknown,
  after: unknown,
) {
  await client.query(
    `INSERT INTO audit_log (actor_user_id, actor_kind, action, target_type, target_id, before_hash, after_hash)
     VALUES ($1, $2, $3, 'cert_project', $4, $5, $6)`,
    [
      identity.userId,
      identity.kind,
      action,
      id,
      before === null ? null : digest(before),
      digest(after),
    ],
  );
}

function safeWriteError(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ['23503', '23514', '23505'].includes(String(error.code))
  ) {
    throw new AppError(400, 'PROJECT_INPUT_INVALID', '项目字段或关联记录无效，请核对后重试。');
  }
  throw new AppError(500, 'PROJECT_WRITE_FAILED', '项目保存失败，本次修改未生效，请稍后重试。');
}

export async function createProject(pool: Pool, identity: ServiceIdentity, input: unknown) {
  const owner = actor(identity);
  const parsed = projectCreateSchema.safeParse(input);
  if (!parsed.success)
    throw new AppError(400, 'PROJECT_INPUT_INVALID', '项目字段缺失或格式无效，请核对后重试。');
  const data = parsed.data;
  const id = randomUUID();
  if (!authorize(owner, 'project.write', { projectId: id, ownerUserId: owner.userId }))
    throw forbidden();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await activeActor(client, owner);
    await reviewerAllowed(client, data.reviewerUserId ?? null);
    const result = await client.query<Record<string, unknown>>(
      `INSERT INTO cert_project AS p
       (id, name, project_type, market, pathway, model_id, owner_user_id, reviewer_user_id,
        applicant_entity_id, holder_entity_id, target_at, jurisdiction_tz, next_action, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$7) RETURNING ${projectFields}`,
      [
        id,
        data.name,
        data.projectType,
        data.market,
        data.pathway,
        data.modelId ?? null,
        owner.userId,
        data.reviewerUserId,
        data.applicantEntityId ?? null,
        data.holderEntityId ?? null,
        data.targetAt ?? null,
        data.jurisdictionTz ?? 'America/New_York',
        data.nextAction ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('项目保存未返回记录');
    const record = projectRecord(row);
    await auditProject(client, owner, 'project.created', record.id, null, record);
    await client.query('COMMIT');
    return record;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    return safeWriteError(error);
  } finally {
    client.release();
  }
}

export async function updateProject(
  pool: Pool,
  identity: ServiceIdentity,
  id: string,
  expectedVersion: number,
  patch: unknown,
) {
  const editor = actor(identity);
  const projectId = identifier(id);
  const version = expectedVersionSchema.safeParse(expectedVersion);
  const changes = projectPatchSchema.safeParse(patch);
  if (
    !version.success ||
    !changes.success ||
    Object.values(changes.data).every((value) => value === undefined)
  )
    throw new AppError(400, 'PROJECT_INPUT_INVALID', '修改字段或基础版本无效，请刷新项目后重试。');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await activeActor(client, editor);
    const before = await readProject(client, editor, projectId, true);
    if (before.version !== version.data)
      throw new AppError(409, 'VERSION_CONFLICT', '项目已被他人修改，请刷新并核对差异后重试。');
    const updated = {
      name: changes.data.name ?? before.name,
      nextAction:
        changes.data.nextAction === undefined ? before.nextAction : changes.data.nextAction,
      targetAt: changes.data.targetAt === undefined ? before.targetAt : changes.data.targetAt,
    };
    const result = await client.query<Record<string, unknown>>(
      `UPDATE cert_project AS p SET name = $1, next_action = $2, target_at = $3,
       version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $4 AND version = $5
       RETURNING ${projectFields}`,
      [updated.name, updated.nextAction, updated.targetAt, projectId, version.data],
    );
    if (!result.rows[0])
      throw new AppError(409, 'VERSION_CONFLICT', '项目已被他人修改，请刷新后重试。');
    const record = projectRecord(result.rows[0]);
    await auditProject(client, editor, 'project.updated', projectId, before, record);
    await client.query('COMMIT');
    return record;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    return safeWriteError(error);
  } finally {
    client.release();
  }
}

export async function getProjectGoals(
  pool: Pool,
  identity: ServiceIdentity,
  id: string,
  options: Pagination = {},
) {
  const viewer = await currentServiceIdentity(pool, identity);
  const projectId = identifier(id);
  await readProject(pool, viewer, projectId);
  const page = pagination(options);
  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${goalFields} FROM goal g WHERE g.project_id = $1
     AND ($2::uuid IS NULL OR g.id > $2::uuid) ORDER BY g.id ASC LIMIT $3`,
    [projectId, page.cursor, page.limit + 1],
  );
  const hasMore = result.rows.length > page.limit;
  const items = result.rows.slice(0, page.limit).map((row) =>
    goalRecordSchema.parse({
      ...row,
      budgetUsd: Number(row.budgetUsd),
      dueAt: iso(row.dueAt),
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    }),
  );
  return { items, hasMore, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
}
