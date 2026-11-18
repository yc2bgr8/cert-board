import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { migrateDatabase, readMigrations } from './migrate.js';
import { createTestDatabase } from './test-database.js';
let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
let directory: string | undefined;
afterEach(async () => {
  await database?.dispose();
  if (directory) {
    if (!path.resolve(directory).startsWith(path.join(tmpdir(), 'cert-c3-migration-')))
      throw Error('临时目录越界');
    await rm(directory, { recursive: true, force: true });
  }
});
test('0010保留历史角色和审计，安全迁移成员/管理权限/会话模式与复核规则', async () => {
  database = await createTestDatabase();
  const pool = database.pool;
  const source = fileURLToPath(new URL('./migrations', import.meta.url));
  directory = await mkdtemp(path.join(tmpdir(), 'cert-c3-migration-'));
  for (const item of await readMigrations(source))
    if (item.filename < '0010')
      await copyFile(path.join(source, item.filename), path.join(directory, item.filename));
  await migrateDatabase(pool, directory);
  const ids: Record<string, string> = {};
  for (const [name, dev, status, roles] of [
    ['member_old', false, 'active', ['RA']],
    ['sales_old', false, 'active', ['SALES']],
    ['tech_old', false, 'active', ['TECH']],
    ['member_admin', false, 'active', ['RA', 'TECH']],
    ['ra', true, 'active', ['RA']],
    ['disabled_old', false, 'disabled', ['RB']],
  ] as const) {
    const id = (
      await pool.query<{ id: string }>(
        "INSERT INTO app_user(username,password_hash,display_name,is_development,status) VALUES($1,'$argon2id$fixture',$1,$2,$3) RETURNING id",
        [name, dev, status],
      )
    ).rows[0]!.id;
    ids[name] = id;
    for (const role of roles)
      await pool.query("INSERT INTO role_binding(user_id,role,scope_type) VALUES($1,$2,'global')", [
        id,
        role,
      ]);
    await pool.query(
      "INSERT INTO web_session(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1::uuid,encode(sha256(convert_to($1::uuid::text,'UTF8')),'hex'),repeat('f',64),now()+interval '1 hour')",
      [id],
    );
  }
  const audit = (
    await pool.query<{ id: string }>(
      "INSERT INTO audit_log(actor_user_id,actor_kind,action,target_type,target_id) VALUES($1::uuid,'browser','fixture.before_c3','app_user',$1::uuid::text) RETURNING id",
      [ids.member_old],
    )
  ).rows[0]!.id;
  const project = (
    await pool.query<{ id: string }>(
      "INSERT INTO cert_project(name,project_type,market,pathway,owner_user_id,reviewer_user_id) VALUES('历史维护','maintenance','US','年度核查',$1,$2) RETURNING id",
      [ids.member_old, ids.member_admin],
    )
  ).rows[0]!.id;
  await pool.query(
    "INSERT INTO conversation(project_id,user_id,title,mode) VALUES($1,$2,'旧执行','execute'),($1,$2,'旧只读','read_only')",
    [project, ids.member_old],
  );
  expect((await migrateDatabase(pool)).applied).toEqual(['0010_member_permissions.sql']);
  const users = (
    await pool.query<{ username: string; status: string; is_management: boolean }>(
      'SELECT username,status,is_management FROM app_user',
    )
  ).rows;
  expect(users.find((u) => u.username === 'member_old')).toMatchObject({
    status: 'active',
    is_management: false,
  });
  expect(users.find((u) => u.username === 'member_admin')).toMatchObject({
    status: 'active',
    is_management: true,
  });
  for (const name of ['sales_old', 'tech_old', 'ra', 'disabled_old'])
    expect(users.find((u) => u.username === name)).toMatchObject({
      status: 'disabled',
      is_management: false,
    });
  expect((await pool.query('SELECT id FROM legacy_role_binding')).rowCount).toBe(7);
  expect(
    (await pool.query("SELECT to_regclass('public.role_binding') AS retired")).rows[0]?.retired,
  ).toBeNull();
  expect(
    (await pool.query('SELECT actor_user_id FROM audit_log WHERE id=$1', [audit])).rows[0]
      ?.actor_user_id,
  ).toBe(ids.member_old);
  expect(
    (await pool.query('SELECT permission_mode,agent_code FROM conversation ORDER BY title')).rows,
  ).toEqual([
    { permission_mode: 'read_only', agent_code: 'maintenance' },
    { permission_mode: 'ask', agent_code: 'maintenance' },
  ]);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM web_session s JOIN app_user u ON u.id=s.user_id WHERE u.status='disabled' AND s.revoked_at IS NULL",
      )
    ).rows[0]?.n,
  ).toBe(0);
  for (const query of [
    'UPDATE legacy_role_binding SET version=version+1',
    'DELETE FROM legacy_role_binding',
    'TRUNCATE legacy_role_binding',
  ])
    await expect(pool.query(query)).rejects.toMatchObject({ code: '42501' });
  await pool.query('UPDATE cert_project SET reviewer_user_id=owner_user_id WHERE id=$1', [project]);
  await pool.query('UPDATE cert_project SET reviewer_user_id=NULL WHERE id=$1', [project]);
  await expect(
    pool.query("UPDATE conversation SET agent_code='registration' WHERE project_id=$1", [project]),
  ).rejects.toMatchObject({ code: '42501' });
  expect(
    (
      await pool.query(
        "SELECT has_table_privilege('cert_board_reader','legacy_role_binding','SELECT') AS allowed",
      )
    ).rows[0]?.allowed,
  ).toBe(false);
});
