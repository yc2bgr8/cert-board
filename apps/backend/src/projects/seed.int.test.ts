import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestDatabase } from '../db/test-database.js';
import { migrateDatabase } from '../db/migrate.js';
import { seedDevelopmentAccounts } from '../db/seed.js';
import { developmentProjectId, developmentGoalId, seedDevelopmentProject } from './seed.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
  await migrateDatabase(database.pool);
  await seedDevelopmentAccounts(database.pool, {
    NODE_ENV: 'test',
    ...Object.fromEntries(
      ['ZHANGSAN', 'WANGMIN', 'ADMIN'].map((role) => [
        `DEV_${role}_PASSWORD`,
        ['seed', 'project', role, 'fixture'].join('-'),
      ]),
    ),
  });
});
afterAll(async () => {
  if (database) await database.dispose();
});

test('L08项目与目标种子幂等，未知期限和主体保持待确认', async () => {
  expect((await seedDevelopmentProject(database.pool, { NODE_ENV: 'test' })).created).toBe(true);
  await database.pool.query(
    'UPDATE cert_project SET next_action=$1,version=version+1 WHERE id=$2',
    ['人补充的方向', developmentProjectId],
  );
  expect((await seedDevelopmentProject(database.pool, { NODE_ENV: 'test' })).created).toBe(false);
  const project = await database.pool.query(
    'SELECT name,target_at,applicant_entity_id,holder_entity_id,model_id,next_action FROM cert_project',
  );
  expect(project.rows).toEqual([
    {
      name: 'L08 510(k)',
      target_at: null,
      applicant_entity_id: null,
      holder_entity_id: null,
      model_id: null,
      next_action: '人补充的方向',
    },
  ]);
  const goals = await database.pool.query('SELECT due_at,status,budget_usd FROM goal');
  expect(goals.rowCount).toBe(1);
  expect(goals.rows[0]).toMatchObject({ due_at: null, status: 'active' });
  expect(Number(goals.rows[0]?.budget_usd)).toBe(10);
});

test('生产环境绝不建立开发项目', async () => {
  await expect(seedDevelopmentProject(database.pool, { NODE_ENV: 'production' })).rejects.toThrow(
    '只允许',
  );
});

test('已有L08仅迁移退役开发负责人，保留人工方向和新成员指派', async () => {
  await seedDevelopmentProject(database.pool, { NODE_ENV: 'test' });
  const legacy = (
    await database.pool.query<{ id: string }>(
      "INSERT INTO app_user(username,password_hash,display_name,is_development,status) VALUES('ra','$argon2id$fixture','旧开发成员',true,'disabled') RETURNING id",
    )
  ).rows[0]!.id;
  await database.pool.query('UPDATE cert_project SET owner_user_id=$1 WHERE id=$2', [
    legacy,
    developmentProjectId,
  ]);
  await database.pool.query('UPDATE goal SET owner_user_id=$1 WHERE id=$2', [
    legacy,
    developmentGoalId,
  ]);
  const members = (
    await database.pool.query<{ id: string; username: string }>(
      "SELECT id,username FROM app_user WHERE username IN ('zhangsan','wangmin')",
    )
  ).rows;
  const owner = members.find((user) => user.username === 'zhangsan')!.id;
  const other = members.find((user) => user.username === 'wangmin')!.id;
  await seedDevelopmentProject(database.pool, { NODE_ENV: 'test' });
  expect(
    (
      await database.pool.query('SELECT owner_user_id,next_action FROM cert_project WHERE id=$1', [
        developmentProjectId,
      ])
    ).rows[0],
  ).toEqual({ owner_user_id: owner, next_action: '人补充的方向' });
  expect(
    (await database.pool.query('SELECT owner_user_id FROM goal WHERE id=$1', [developmentGoalId]))
      .rows[0]?.owner_user_id,
  ).toBe(owner);
  expect(
    (
      await database.pool.query(
        "SELECT id FROM audit_log WHERE action='development.owner_migrated'",
      )
    ).rowCount,
  ).toBe(2);
  await database.pool.query('UPDATE cert_project SET owner_user_id=$1 WHERE id=$2', [
    other,
    developmentProjectId,
  ]);
  await seedDevelopmentProject(database.pool, { NODE_ENV: 'test' });
  expect(
    (
      await database.pool.query('SELECT owner_user_id FROM cert_project WHERE id=$1', [
        developmentProjectId,
      ])
    ).rows[0]?.owner_user_id,
  ).toBe(other);
});
