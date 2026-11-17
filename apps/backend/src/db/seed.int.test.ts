import * as argon2 from 'argon2';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { migrateDatabase } from './migrate.js';
import { createTestDatabase } from './test-database.js';
import { DevelopmentSeedError, seedDevelopmentAccounts } from './seed.js';

const samplePassword = (role: string) => ['integration', 'test', role, '123456789'].join('-');
const environment = {
  NODE_ENV: 'test',
  DEV_RA_PASSWORD: samplePassword('ra'),
  DEV_RB_PASSWORD: samplePassword('rb'),
  DEV_GM_PASSWORD: samplePassword('gm'),
  DEV_SALES_PASSWORD: samplePassword('sales'),
  DEV_TECH_PASSWORD: samplePassword('tech'),
};
let database: Awaited<ReturnType<typeof createTestDatabase>>;

beforeEach(async () => {
  database = await createTestDatabase();
  await migrateDatabase(database.pool);
});
afterEach(async () => {
  if (database) await database.dispose();
});

test('五种开发角色种子幂等，密码哈希可验证，重复执行不会重置账号', async () => {
  const first = await seedDevelopmentAccounts(database.pool, environment);
  expect(first.created).toEqual(['ra', 'rb', 'gm', 'sales', 'tech']);
  const before = await database.pool.query<{
    username: string;
    password_hash: string;
    status: string;
    is_development: boolean;
  }>('SELECT username, password_hash, status, is_development FROM app_user ORDER BY username');
  expect(before.rowCount).toBe(5);
  for (const user of before.rows) {
    expect(user.is_development).toBe(true);
    expect(user.status).toBe('active');
    expect(user.password_hash.startsWith('$argon2id$')).toBe(true);
    const password =
      environment[`DEV_${user.username.toUpperCase()}_PASSWORD` as keyof typeof environment];
    expect(await argon2.verify(user.password_hash, password)).toBe(true);
  }
  const second = await seedDevelopmentAccounts(database.pool, {
    ...environment,
    DEV_RA_PASSWORD: samplePassword('changed'),
  });
  expect(second.created).toEqual([]);
  expect(second.unchanged).toHaveLength(5);
  const after = await database.pool.query(
    'SELECT username, password_hash, status, is_development FROM app_user ORDER BY username',
  );
  // 不让断言失败时把密码哈希写入测试日志。
  expect(JSON.stringify(after.rows) === JSON.stringify(before.rows)).toBe(true);
  const roles = await database.pool.query(
    'SELECT role, scope_type FROM role_binding ORDER BY role',
  );
  expect(roles.rowCount).toBe(5);
  expect(roles.rows.find((row) => row.role === 'SALES')?.scope_type).toBe('own');
  const audit = await database.pool.query('SELECT action, before_hash, after_hash FROM audit_log');
  expect(audit.rowCount).toBe(5);
  expect(
    audit.rows.every(
      (row) => row.action === 'user.seeded' && row.before_hash === null && row.after_hash === null,
    ),
  ).toBe(true);
});

test('人工禁用账号或移除角色后，种子不会恢复状态或权限', async () => {
  await seedDevelopmentAccounts(database.pool, environment);
  await database.pool.query("UPDATE app_user SET status = 'disabled' WHERE username = 'ra'");
  await database.pool.query(
    "DELETE FROM role_binding WHERE user_id = (SELECT id FROM app_user WHERE username = 'ra')",
  );
  await seedDevelopmentAccounts(database.pool, environment);
  const result = await database.pool.query("SELECT status FROM app_user WHERE username = 'ra'");
  const roles = await database.pool.query(
    "SELECT id FROM role_binding WHERE user_id = (SELECT id FROM app_user WHERE username = 'ra')",
  );
  expect(result.rows[0]?.status).toBe('disabled');
  expect(roles.rowCount).toBe(0);
});

test('已有同名非开发账号时拒绝初始化，不能接管或提权', async () => {
  const passwordHash = await argon2.hash(samplePassword('collision'), {
    type: argon2.argon2id,
  });
  await database.pool.query(
    "INSERT INTO app_user (username, password_hash, display_name) VALUES ('ra', $1, '真实账号占位')",
    [passwordHash],
  );
  await expect(seedDevelopmentAccounts(database.pool, environment)).rejects.toBeInstanceOf(
    DevelopmentSeedError,
  );
  const roles = await database.pool.query(
    "SELECT id FROM role_binding WHERE user_id = (SELECT id FROM app_user WHERE username = 'ra')",
  );
  expect(roles.rowCount).toBe(0);
  const counts = await database.pool.query('SELECT count(*)::integer AS count FROM audit_log');
  expect(counts.rows[0]?.count).toBe(0);
  const users = await database.pool.query('SELECT count(*)::integer AS count FROM app_user');
  expect(users.rows[0]?.count).toBe(1);
});
