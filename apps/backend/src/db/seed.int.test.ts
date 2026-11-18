import * as argon2 from 'argon2';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { migrateDatabase } from './migrate.js';
import { createTestDatabase } from './test-database.js';
import { DevelopmentSeedError, seedDevelopmentAccounts } from './seed.js';
const password = (name: string) => `integration-member-${name}-fixture`;
const environment = {
  NODE_ENV: 'test',
  DEV_ZHANGSAN_PASSWORD: password('zhangsan'),
  DEV_WANGMIN_PASSWORD: password('wangmin'),
  DEV_ADMIN_PASSWORD: password('admin'),
};
let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeEach(async () => {
  database = await createTestDatabase();
  await migrateDatabase(database.pool);
});
afterEach(async () => {
  await database?.dispose();
});
test('三名开发成员种子幂等，仅显式管理员有管理权限，密码不被重置', async () => {
  expect((await seedDevelopmentAccounts(database.pool, environment)).created).toEqual([
    'zhangsan',
    'wangmin',
    'admin',
  ]);
  const before = (
    await database.pool.query<{
      username: string;
      password_hash: string;
      is_management: boolean;
      is_development: boolean;
    }>('SELECT username,password_hash,is_management,is_development FROM app_user ORDER BY username')
  ).rows;
  expect(before).toHaveLength(3);
  for (const user of before) {
    expect(user.is_management).toBe(user.username === 'admin');
    expect(user.is_development).toBe(true);
    expect(await argon2.verify(user.password_hash, password(user.username))).toBe(true);
  }
  const repeat = await seedDevelopmentAccounts(database.pool, {
    ...environment,
    DEV_ZHANGSAN_PASSWORD: password('changed'),
  });
  expect(repeat.created).toEqual([]);
  expect(repeat.unchanged).toHaveLength(3);
  const after = (
    await database.pool.query(
      'SELECT username,password_hash,is_management,is_development FROM app_user ORDER BY username',
    )
  ).rows;
  expect(JSON.stringify(before) === JSON.stringify(after)).toBe(true);
  expect((await database.pool.query('SELECT id FROM legacy_role_binding')).rowCount).toBe(0);
  expect(
    (await database.pool.query("SELECT id FROM audit_log WHERE action='user.seeded'")).rowCount,
  ).toBe(3);
});
test('种子不恢复人工禁用或撤销的管理权限', async () => {
  await seedDevelopmentAccounts(database.pool, environment);
  await database.pool.query("UPDATE app_user SET status='disabled' WHERE username='zhangsan'");
  await database.pool.query("UPDATE app_user SET is_management=false WHERE username='admin'");
  await seedDevelopmentAccounts(database.pool, environment);
  expect(
    (await database.pool.query("SELECT status FROM app_user WHERE username='zhangsan'")).rows[0]
      ?.status,
  ).toBe('disabled');
  expect(
    (await database.pool.query("SELECT is_management FROM app_user WHERE username='admin'")).rows[0]
      ?.is_management,
  ).toBe(false);
});
test('同名非开发账号不被接管或提权，整笔种子回滚', async () => {
  await database.pool.query(
    "INSERT INTO app_user(username,password_hash,display_name) VALUES('admin','$argon2id$fixture','真实账号占位')",
  );
  await expect(seedDevelopmentAccounts(database.pool, environment)).rejects.toBeInstanceOf(
    DevelopmentSeedError,
  );
  expect((await database.pool.query('SELECT id FROM app_user')).rowCount).toBe(1);
  expect(
    (await database.pool.query("SELECT is_management FROM app_user WHERE username='admin'")).rows[0]
      ?.is_management,
  ).toBe(false);
  expect((await database.pool.query('SELECT id FROM audit_log')).rowCount).toBe(0);
});
test('只退役精确匹配的旧开发账号，保留UUID/历史并撤销会话', async () => {
  const old = (
    await database.pool.query<{ id: string }>(
      "INSERT INTO app_user(username,password_hash,display_name,is_development,is_management) VALUES('ra','$argon2id$fixture','旧开发',true,true) RETURNING id",
    )
  ).rows[0]!.id;
  await database.pool.query(
    "INSERT INTO app_user(username,password_hash,display_name) VALUES('rb','$argon2id$fixture','同名真实成员')",
  );
  await database.pool.query(
    "INSERT INTO web_session(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,repeat('a',64),repeat('b',64),now()+interval '1 hour')",
    [old],
  );
  await database.pool.query(
    "INSERT INTO audit_log(actor_user_id,actor_kind,action,target_type,target_id) VALUES($1::uuid,'browser','fixture.history','app_user',$1::uuid::text)",
    [old],
  );
  await seedDevelopmentAccounts(database.pool, environment);
  expect(
    (await database.pool.query('SELECT status,is_management FROM app_user WHERE id=$1', [old]))
      .rows[0],
  ).toEqual({ status: 'disabled', is_management: false });
  expect(
    (await database.pool.query("SELECT status FROM app_user WHERE username='rb'")).rows[0]?.status,
  ).toBe('active');
  expect(
    (
      await database.pool.query(
        'SELECT revoked_at IS NOT NULL AS revoked FROM web_session WHERE user_id=$1',
        [old],
      )
    ).rows[0]?.revoked,
  ).toBe(true);
  expect(
    (
      await database.pool.query(
        "SELECT actor_user_id FROM audit_log WHERE action='fixture.history'",
      )
    ).rows[0]?.actor_user_id,
  ).toBe(old);
});
