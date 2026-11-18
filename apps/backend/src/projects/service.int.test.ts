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
let admin: BrowserIdentity;
let own: BrowserIdentity;
const examplePassword = (role: string) => ['project', 'integration', role, 'example'].join('-');

async function identity(username: string) {
  const user = await database.pool.query(
    'SELECT id, username, display_name, is_development, is_management FROM app_user WHERE username = $1',
    [username],
  );
  const record = user.rows[0];
  return browserIdentitySchema.parse({
    kind: 'browser',
    userId: record.id,
    sessionId: randomUUID(),
    username: record.username,
    displayName: record.display_name,
    isDevelopment: record.is_development,
    isManagement: record.is_management,
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
    DEV_ZHANGSAN_PASSWORD: examplePassword('zhangsan'),
    DEV_WANGMIN_PASSWORD: examplePassword('wangmin'),
    DEV_ADMIN_PASSWORD: examplePassword('admin'),
  });
  await database.pool.query(
    "INSERT INTO app_user (username, password_hash, display_name, is_development) SELECT 'ownra', password_hash, '另一部门成员', true FROM app_user WHERE username = 'zhangsan'",
  );
  [ra, rb, admin, own] = await Promise.all([
    identity('zhangsan'),
    identity('wangmin'),
    identity('admin'),
    identity('ownra'),
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

test('活动部门成员共享项目读取与修改，负责人不形成独占范围', async () => {
  const mine = await createProject(database.pool, own, input('本人可访问的项目'));
  const other = await createProject(database.pool, ra, input('其他用户的项目'));
  expect((await getProject(database.pool, own, mine.id)).id).toBe(mine.id);
  expect((await getProject(database.pool, own, other.id)).id).toBe(other.id);
  expect(
    (await updateProject(database.pool, own, other.id, 1, { name: '同事协作修改' })).version,
  ).toBe(2);
  const result = await listProjects(database.pool, rb);
  expect(result.items.some((item) => item.id === mine.id)).toBe(true);
  expect(result.items.some((item) => item.id === other.id)).toBe(true);
});

test('管理标记不限制普通业务，禁用成员的旧身份不能继续读写', async () => {
  const project = await createProject(database.pool, admin, input('管理成员业务测试'));
  expect(
    (await updateProject(database.pool, rb, project.id, 1, { name: '普通成员修改' })).version,
  ).toBe(2);
  await database.pool.query("UPDATE app_user SET status='disabled' WHERE id=$1", [own.userId]);
  try {
    await expect(listProjects(database.pool, own)).rejects.toMatchObject({ statusCode: 403 });
    await expect(getProject(database.pool, own, project.id)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(createProject(database.pool, own, input('禁用成员新建'))).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(
      updateProject(database.pool, own, project.id, 2, { name: '禁用成员修改' }),
    ).rejects.toMatchObject({ statusCode: 403 });
  } finally {
    await database.pool.query("UPDATE app_user SET status='active' WHERE id=$1", [own.userId]);
  }
});

test('创建时不能篡改负责人，复核人可空或本人但必须是有效成员', async () => {
  await expect(
    createProject(database.pool, ra, { ...input('伪造负责人'), ownerUserId: rb.userId }),
  ).rejects.toMatchObject({ statusCode: 400 });
  expect(
    (await createProject(database.pool, ra, { ...input('自行审核'), reviewerUserId: ra.userId }))
      .reviewerUserId,
  ).toBe(ra.userId);
  expect(
    (await createProject(database.pool, ra, { ...input('无需指定复核人'), reviewerUserId: null }))
      .reviewerUserId,
  ).toBeNull();
  await expect(
    createProject(database.pool, ra, { ...input('无效复核人'), reviewerUserId: randomUUID() }),
  ).rejects.toMatchObject({ statusCode: 400 });
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

test('共享项目列表分页不重复，成员能续读所有项目', async () => {
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

test('目标仍按项目过滤但不按负责人隐藏，分页与预算数值保护保持', async () => {
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
  expect(first.items[0]?.budgetUsd).toBe(10);
  expect(first.hasMore).toBe(true);
  const next = await getProjectGoals(database.pool, own, project.id, {
    limit: 1,
    cursor: first.nextCursor ?? '',
  });
  expect(next.items).toHaveLength(1);
  expect(next.items[0]?.id === first.items[0]?.id).toBe(false);
  expect(next.hasMore).toBe(true);
  const third = await getProjectGoals(database.pool, own, project.id, {
    limit: 1,
    cursor: next.nextCursor ?? '',
  });
  expect(third.hasMore).toBe(false);
  expect((await getProjectGoals(database.pool, admin, project.id)).items).toHaveLength(3);
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
