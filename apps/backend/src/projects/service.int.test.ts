import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { browserIdentitySchema, type BrowserIdentity } from '@cert-board/shared';
import { migrateDatabase } from '../db/migrate.js';
import { seedDevelopmentAccounts } from '../db/seed.js';
import { createTestDatabase } from '../db/test-database.js';
import {
  createProject,
  getProject,
  getProjectGoals,
  listProjects,
  updateProject,
} from './service.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let ra: BrowserIdentity;
let rb: BrowserIdentity;
let gm: BrowserIdentity;
let own: BrowserIdentity;
let sales: BrowserIdentity;
const examplePassword = (role: string) => ['project', 'integration', role, 'example'].join('-');

async function identity(username: string) {
  const user = await database.pool.query(
    'SELECT id, username, display_name, is_development FROM app_user WHERE username = $1',
    [username],
  );
  const record = user.rows[0];
  const bindings = await database.pool.query(
    'SELECT role, scope_type AS "scopeType", scope_id AS "scopeId" FROM role_binding WHERE user_id = $1',
    [record.id],
  );
  return browserIdentitySchema.parse({
    kind: 'browser',
    userId: record.id,
    sessionId: randomUUID(),
    username: record.username,
    displayName: record.display_name,
    isDevelopment: record.is_development,
    roles: bindings.rows,
  });
}
const input = (name: string) => ({
  name,
  projectType: 'registration',
  market: 'US',
  pathway: '510(k)',
  reviewerUserId: rb.userId,
});

beforeAll(async () => {
  database = await createTestDatabase();
  await migrateDatabase(database.pool);
  await seedDevelopmentAccounts(database.pool, {
    NODE_ENV: 'test',
    DEV_RA_PASSWORD: examplePassword('ra'),
    DEV_RB_PASSWORD: examplePassword('rb'),
    DEV_GM_PASSWORD: examplePassword('gm'),
    DEV_SALES_PASSWORD: examplePassword('sales'),
    DEV_TECH_PASSWORD: examplePassword('tech'),
  });
  await database.pool.query(
    "INSERT INTO app_user (username, password_hash, display_name, is_development) SELECT 'ownra', password_hash, '本人范围注册人员', true FROM app_user WHERE username = 'ra'",
  );
  await database.pool.query(
    "INSERT INTO role_binding (user_id, role, scope_type) SELECT id, 'RA', 'own' FROM app_user WHERE username = 'ownra'",
  );
  [ra, rb, gm, own, sales] = await Promise.all([
    identity('ra'),
    identity('rb'),
    identity('gm'),
    identity('ownra'),
    identity('sales'),
  ]);
});
afterAll(async () => {
  if (database) await database.dispose();
});

test('建立和修改项目保持主体编号、带时区时间与版本，审计只保存哈希', async () => {
  const project = await createProject(database.pool, ra, {
    ...input("虚构项目'; SELECT 1; --"),
    targetAt: '2027-01-15T17:00:00-05:00',
    nextAction: '核对资料',
  });
  expect(project.ownerUserId).toBe(ra.userId);
  expect(project.reviewerUserId).toBe(rb.userId);
  expect(project.version).toBe(1);
  expect(project.targetAt).toBe('2027-01-15T22:00:00.000Z');
  expect(project.name).toBe("虚构项目'; SELECT 1; --");
  const next = await updateProject(database.pool, ra, project.id, 1, {
    name: '更新后的项目',
    nextAction: null,
  });
  expect(next.version).toBe(2);
  expect(next.nextAction).toBeNull();
  expect(next.targetAt).toBe(project.targetAt);
  const audits = await database.pool.query(
    "SELECT action, before_hash, after_hash FROM audit_log WHERE target_type = 'cert_project' AND target_id = $1 ORDER BY created_at",
    [project.id],
  );
  expect(audits.rows.map((row) => row.action)).toEqual(['project.created', 'project.updated']);
  expect(audits.rows[0]?.before_hash).toBeNull();
  expect(audits.rows.every((row) => /^[a-f0-9]{64}$/.test(row.after_hash))).toBe(true);
  expect(audits.rows[1]?.before_hash === audits.rows[1]?.after_hash).toBe(false);
  expect(JSON.stringify(audits.rows).includes('更新后的项目')).toBe(false);
});

test('同版本的并发修改只有一次成功，另一次返回409且不写入重复审计', async () => {
  const project = await createProject(database.pool, ra, input('并发更新测试'));
  const outcomes = await Promise.allSettled([
    updateProject(database.pool, ra, project.id, 1, { nextAction: '第一份修改' }),
    updateProject(database.pool, ra, project.id, 1, { nextAction: '第二份修改' }),
  ]);
  expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const failure = outcomes.find((result) => result.status === 'rejected');
  expect(failure?.status === 'rejected' && failure.reason.statusCode === 409).toBe(true);
  expect((await getProject(database.pool, ra, project.id)).version).toBe(2);
  const audits = await database.pool.query(
    "SELECT id FROM audit_log WHERE action = 'project.updated' AND target_id = $1",
    [project.id],
  );
  expect(audits.rowCount).toBe(1);
});

test('本人范围和项目范围不能读取或修改其他项目，角色不能拼接扩大范围', async () => {
  const mine = await createProject(database.pool, own, input('本人可访问的项目'));
  const other = await createProject(database.pool, ra, input('其他用户的项目'));
  expect((await getProject(database.pool, own, mine.id)).id).toBe(mine.id);
  await expect(getProject(database.pool, own, other.id)).rejects.toMatchObject({ statusCode: 404 });
  await expect(
    updateProject(database.pool, own, other.id, 1, { name: '越权修改' }),
  ).rejects.toMatchObject({ statusCode: 404 });
  const scoped = {
    ...ra,
    roles: [{ role: 'RA' as const, scopeType: 'project' as const, scopeId: mine.id }],
  };
  expect((await getProject(database.pool, scoped, mine.id)).id).toBe(mine.id);
  await expect(getProject(database.pool, scoped, other.id)).rejects.toMatchObject({
    statusCode: 404,
  });
  await expect(createProject(database.pool, scoped, input('越权新项目'))).rejects.toMatchObject({
    statusCode: 403,
  });
  const combined = {
    ...own,
    roles: [...own.roles, { role: 'TECH' as const, scopeType: 'global' as const, scopeId: null }],
  };
  const result = await listProjects(database.pool, combined);
  expect(result.items.every((item) => item.ownerUserId === own.userId)).toBe(true);
  expect(result.items.some((item) => item.id === other.id)).toBe(false);
});

test('GM只能读取，销售不能访问项目服务', async () => {
  const project = await createProject(database.pool, ra, input('只读授权测试'));
  expect((await getProject(database.pool, gm, project.id)).id).toBe(project.id);
  await expect(createProject(database.pool, gm, input('GM新建'))).rejects.toMatchObject({
    statusCode: 403,
  });
  await expect(
    updateProject(database.pool, gm, project.id, 1, { name: 'GM修改' }),
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(listProjects(database.pool, sales)).rejects.toMatchObject({ statusCode: 403 });
  await expect(getProject(database.pool, sales, project.id)).rejects.toMatchObject({
    statusCode: 403,
  });
});

test('创建时不能篡改负责人，复核人必须不同且有对应注册权限', async () => {
  await expect(
    createProject(database.pool, ra, { ...input('伪造负责人'), ownerUserId: rb.userId }),
  ).rejects.toMatchObject({ statusCode: 400 });
  for (const reviewerUserId of [ra.userId, gm.userId, sales.userId, own.userId, randomUUID()]) {
    await expect(
      createProject(database.pool, ra, { ...input('无效复核人'), reviewerUserId }),
    ).rejects.toMatchObject({ statusCode: 400 });
  }
  try {
    await database.pool.query("UPDATE app_user SET status = 'disabled' WHERE id = $1", [rb.userId]);
    await expect(createProject(database.pool, ra, input('禁用复核人'))).rejects.toMatchObject({
      statusCode: 400,
    });
  } finally {
    await database.pool.query("UPDATE app_user SET status = 'active' WHERE id = $1", [rb.userId]);
  }
});

test('项目更新仅接受三个字段，不接受状态、预算、负责人或空修改', async () => {
  const project = await createProject(database.pool, ra, input('修改边界测试'));
  for (const patch of [
    { status: 'approved' },
    { budgetUsd: 999 },
    { ownerUserId: rb.userId },
    {},
    { nextAction: undefined },
  ]) {
    await expect(updateProject(database.pool, ra, project.id, 1, patch)).rejects.toMatchObject({
      statusCode: 400,
    });
  }
  await expect(
    updateProject(database.pool, ra, project.id, 0, { name: '无效版本' }),
  ).rejects.toMatchObject({ statusCode: 400 });
  expect((await getProject(database.pool, ra, project.id)).version).toBe(1);
});

test('列表只对授权结果分页，续读不会重复或包含其他人的项目', async () => {
  const existingCount = (await listProjects(database.pool, own)).items.length;
  await createProject(database.pool, own, input('分页项目甲'));
  await createProject(database.pool, own, input('分页项目乙'));
  await createProject(database.pool, own, input('分页项目丙'));
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
    const page = await listProjects(
      database.pool,
      own,
      cursor ? { cursor, limit: 2 } : { limit: 2 },
    );
    expect(page.items.length <= 2).toBe(true);
    for (const item of page.items) {
      expect(item.ownerUserId).toBe(own.userId);
      expect(seen.has(item.id)).toBe(false);
      seen.add(item.id);
    }
    if (!page.hasMore) {
      expect(page.nextCursor).toBeNull();
      break;
    }
    expect(page.nextCursor).not.toBeNull();
    cursor = page.nextCursor ?? undefined;
  }
  expect(seen.size).toBe(existingCount + 3);
  await expect(listProjects(database.pool, own, { limit: 51 })).rejects.toMatchObject({
    statusCode: 400,
  });
});

test('目标按项目和负责人范围过滤并支持续读，预算NaN被数据库拒绝', async () => {
  const project = await createProject(database.pool, own, input('目标范围测试'));
  for (const [title, ownerId] of [
    ['本人目标甲', own.userId],
    ['本人目标乙', own.userId],
    ['他人目标', ra.userId],
  ]) {
    await database.pool.query(
      "INSERT INTO goal (project_id, owner_user_id, title, acceptance_criteria) VALUES ($1,$2,$3,'示例验收条件')",
      [project.id, ownerId, title],
    );
  }
  const first = await getProjectGoals(database.pool, own, project.id, { limit: 1 });
  expect(first.items).toHaveLength(1);
  expect(first.items[0]?.ownerUserId).toBe(own.userId);
  expect(first.items[0]?.budgetUsd).toBe(10);
  expect(first.hasMore).toBe(true);
  const next = await getProjectGoals(database.pool, own, project.id, {
    limit: 1,
    cursor: first.nextCursor ?? '',
  });
  expect(next.items).toHaveLength(1);
  expect(next.items[0]?.id === first.items[0]?.id).toBe(false);
  expect(next.hasMore).toBe(false);
  expect((await getProjectGoals(database.pool, gm, project.id)).items).toHaveLength(3);
  await expect(
    database.pool.query(
      "INSERT INTO goal (project_id, owner_user_id, title, acceptance_criteria, budget_usd) VALUES ($1,$2,'无效预算','示例条件','NaN')",
      [project.id, ra.userId],
    ),
  ).rejects.toMatchObject({ code: '23514' });
});

test('冻结快照在数据库层拒绝更新、删除与清空', async () => {
  const project = await createProject(database.pool, ra, input('快照保护测试'));
  const snapshot = await database.pool.query<{ id: string }>(
    `INSERT INTO submission_snapshot (project_id, sequence, kind, file_manifest, manifest_sha256, created_by)
     VALUES ($1,1,'approved_review','[]'::jsonb,$2,$3) RETURNING id`,
    [project.id, 'a'.repeat(64), ra.userId],
  );
  const id = snapshot.rows[0]?.id;
  for (const sql of [
    "UPDATE submission_snapshot SET kind='rehearsal' WHERE id=$1",
    'DELETE FROM submission_snapshot WHERE id=$1',
  ]) {
    await expect(database.pool.query(sql, [id])).rejects.toMatchObject({ code: '42501' });
  }
  await expect(database.pool.query('TRUNCATE submission_snapshot')).rejects.toMatchObject({
    code: '0A000',
  });
  await expect(database.pool.query('TRUNCATE submission_snapshot CASCADE')).rejects.toMatchObject({
    code: '42501',
  });
  expect(
    (await database.pool.query('SELECT id FROM submission_snapshot WHERE id=$1', [id])).rowCount,
  ).toBe(1);
});

test('项目编号跨越四位后仍完整且保持唯一', async () => {
  await database.pool.query("SELECT setval('cert_project_code_seq',9998,true)");
  const first = await createProject(database.pool, ra, input('编号边界甲'));
  const second = await createProject(database.pool, ra, input('编号边界乙'));
  expect(first.code).toBe('C9999');
  expect(second.code).toBe('C10000');
});
