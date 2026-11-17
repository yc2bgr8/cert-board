import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateDatabase, readMigrations } from './migrate.js';
import { createTestDatabase } from './test-database.js';
import { createDatabase } from './client.js';
import { legalEntity } from './schema.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let firstMigrationCount = 0;
beforeAll(async () => {
  database = await createTestDatabase();
  firstMigrationCount = (await migrateDatabase(database.pool)).applied.length;
});
afterAll(async () => {
  if (database) await database.dispose();
});

test('全新数据库迁移成功，重复执行不改变结构和历史', async () => {
  expect(firstMigrationCount).toBeGreaterThan(0);
  expect((await migrateDatabase(database.pool)).applied).toEqual([]);
  const result = await database.pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
  );
  expect(result.rows.map((row) => row.table_name)).toEqual(
    expect.arrayContaining([
      'app_user',
      'role_binding',
      'web_session',
      'audit_log',
      'legal_entity',
      'entity_role',
    ]),
  );
  expect(await createDatabase(database.pool).select().from(legalEntity)).toEqual([]);
});

test('并发迁移只执行一次', async () => {
  const isolated = await createTestDatabase();
  try {
    const results = await Promise.all([
      migrateDatabase(isolated.pool),
      migrateDatabase(isolated.pool),
    ]);
    const migrationCount = (
      await readMigrations(fileURLToPath(new URL('./migrations', import.meta.url)))
    ).length;
    expect(results.reduce((count, result) => count + result.applied.length, 0)).toBe(
      migrationCount,
    );
  } finally {
    await isolated.dispose();
  }
});

test('新迁移失败时结构和账本一起回滚，修复后可重跑', async () => {
  const isolated = await createTestDatabase();
  const directory = await mkdtemp(path.join(tmpdir(), 'cert-migration-rollback-'));
  try {
    await cp(fileURLToPath(new URL('./migrations', import.meta.url)), directory, {
      recursive: true,
    });
    await migrateDatabase(isolated.pool, directory);
    const { writeFile } = await import('node:fs/promises');
    const failed = path.join(directory, '9999_failure.sql');
    await writeFile(
      failed,
      'CREATE TABLE rollback_probe(id integer); SELECT missing_function_for_test();',
    );
    await expect(migrateDatabase(isolated.pool, directory)).rejects.toThrow();
    expect(
      (await isolated.pool.query("SELECT to_regclass('public.rollback_probe') AS name")).rows[0]
        ?.name,
    ).toBeNull();
    expect(
      (
        await isolated.pool.query(
          "SELECT filename FROM cert_schema_migration WHERE filename='9999_failure.sql'",
        )
      ).rowCount,
    ).toBe(0);
    await writeFile(failed, 'CREATE TABLE rollback_probe(id integer);');
    expect((await migrateDatabase(isolated.pool, directory)).applied).toEqual(['9999_failure.sql']);
  } finally {
    await isolated.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('审计日志的更新、删除和整表清空均被数据库拒绝', async () => {
  const targetId = randomUUID();
  await database.pool.query(
    "INSERT INTO audit_log(actor_kind, action, target_type, target_id) VALUES ('system', 'test.created', 'fixture', $1)",
    [targetId],
  );
  await expect(
    database.pool.query("UPDATE audit_log SET action='test.changed' WHERE target_id=$1", [
      targetId,
    ]),
  ).rejects.toThrow();
  await expect(
    database.pool.query('DELETE FROM audit_log WHERE target_id=$1', [targetId]),
  ).rejects.toThrow();
  await expect(database.pool.query('TRUNCATE audit_log')).rejects.toThrow();
  const result = await database.pool.query('SELECT action FROM audit_log WHERE target_id=$1', [
    targetId,
  ]);
  expect(result.rows).toEqual([{ action: 'test.created' }]);
});

test('只读角色可读业务表，不能写业务或读取认证秘密', async () => {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE cert_board_reader');
    await client.query('SELECT id FROM legal_entity LIMIT 1');
    await expect(client.query('UPDATE legal_entity SET name=name')).rejects.toMatchObject({
      code: '42501',
    });
    await client.query('ROLLBACK');
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE cert_board_reader');
    await expect(client.query('SELECT password_hash FROM app_user')).rejects.toMatchObject({
      code: '42501',
    });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('所有基础表的时间字段使用带时区时间点', async () => {
  const result = await database.pool.query<{ data_type: string }>(
    "SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('created_at','updated_at','expires_at')",
  );
  expect(result.rows.length).toBeGreaterThanOrEqual(12);
  expect(result.rows.every((row) => row.data_type === 'timestamp with time zone')).toBe(true);
});

test('已执行迁移内容被改动会拒绝运行，不修改原始迁移', async () => {
  const source = fileURLToPath(new URL('./migrations', import.meta.url));
  const directory = await mkdtemp(path.join(tmpdir(), 'cert-migration-tamper-'));
  try {
    await cp(source, directory, { recursive: true });
    const files = await readMigrations(directory);
    await appendFile(path.join(directory, files[0]!.filename), '\n-- simulated change\n');
    await expect(migrateDatabase(database.pool, directory)).rejects.toThrow(
      '已执行的迁移被修改或缺失',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
