import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { seedDevelopmentRulePack } from '../knowledge/rule-packs.js';
import { createIntegrationContext } from '../test-support/context.js';
import { scanM02Schedules } from './m02-schedule.js';

let context: Awaited<ReturnType<typeof createIntegrationContext>>;
afterEach(async () => context?.close());

async function setup() {
  context = await createIntegrationContext();
  const pool = context.pool;
  const owner = context.userId('MEMBER_A');
  const project = randomUUID();
  const goal = randomUUID();
  const workspace = randomUUID();
  const version = randomUUID();
  await pool.query(
    `INSERT INTO cert_project(id,name,project_type,market,pathway,jurisdiction_tz,owner_user_id)
       VALUES($1,'合成美国维护项目','maintenance','US','年度注册','America/New_York',$2)`,
    [project, owner],
  );
  await pool.query(
    "INSERT INTO goal(id,project_id,owner_user_id,title,acceptance_criteria) VALUES($1,$2,$3,'合成维护目标','送审核对结果')",
    [goal, project, owner],
  );
  await pool.query('INSERT INTO workspace(id,project_id) VALUES($1,$2)', [workspace, project]);
  await pool.query(
    "INSERT INTO workspace_version(id,workspace_id,project_id,number,author_type,summary,data_level) VALUES($1,$2,$3,1,'system','合成项目','internal')",
    [version, workspace, project],
  );
  await pool.query('UPDATE workspace SET current_version_id=$2 WHERE id=$1', [workspace, version]);
  const pack = await seedDevelopmentRulePack(pool, 'test');
  return { pool, owner, project, goal, workspace, pack };
}

test('只有当前负责人能通过浏览器启停，旧设置版本不能覆盖', async () => {
  const { goal, project, pool } = await setup();
  const login = await context.login();
  const coworker = await context.login('MEMBER_B');
  const url = `/api/goals/${goal}/m02-schedule`;
  const write = (headers: typeof login.headers, enabled: boolean, expectedVersion: number) =>
    context.app.inject({ method: 'POST', url, headers, payload: { enabled, expectedVersion } });
  expect((await context.app.inject({ url, headers: login.headers })).json()).toEqual({
    enabled: false,
    version: 0,
    updatedAt: null,
  });
  expect((await write(coworker.headers, true, 0)).statusCode).toBe(404);
  expect((await write({ ...login.headers, 'x-csrf-token': 'invalid' }, true, 0)).statusCode).toBe(
    403,
  );
  expect((await write(login.headers, true, 0)).json()).toMatchObject({ enabled: true, version: 1 });
  expect((await write(login.headers, false, 0)).statusCode).toBe(409);
  await pool.query("UPDATE cert_project SET status='closed' WHERE id=$1", [project]);
  expect(await scanM02Schedules(pool, 'test', new Date('2027-09-30T16:00Z'))).toBe(0);
  expect((await write(login.headers, false, 1)).json()).toMatchObject({
    enabled: false,
    version: 2,
  });
  expect((await write(login.headers, true, 2)).statusCode).toBe(409);
});

test('按法域月份唤醒离线负责人，年度窗口前一天触发，扫描并发不会重复', async () => {
  const { pool, owner, goal, pack, workspace } = await setup();
  const login = await context.login();
  const enabled = await context.app.inject({
    method: 'POST',
    url: `/api/goals/${goal}/m02-schedule`,
    headers: login.headers,
    payload: { enabled: true, expectedVersion: 0 },
  });
  expect(enabled.statusCode).toBe(200);
  expect(
    (await context.app.inject({ method: 'POST', url: '/api/auth/logout', headers: login.headers }))
      .statusCode,
  ).toBe(204);
  await pool.query("UPDATE workspace SET data_level='confidential' WHERE id=$1", [workspace]);
  expect(await scanM02Schedules(pool, 'production', new Date('2027-09-30T03:59Z'))).toBe(0);
  expect(await scanM02Schedules(pool, 'test', new Date('2027-09-30T03:59Z'))).toBe(1);
  const first = await pool.query<{ source_key: string; run_id: string }>(
    'SELECT source_key,wake_run_id AS run_id FROM goal_event WHERE goal_id=$1',
    [goal],
  );
  expect(first.rows.map(({ source_key }) => source_key)).toEqual([`m02:${goal}:monthly:2027-09`]);
  const due = new Date('2027-09-30T04:00Z');
  expect(await scanM02Schedules(pool, 'test', due)).toBe(0); // 已有未结束运行。
  await pool.query("UPDATE run SET status='completed',finished_at=now() WHERE id=$1", [
    first.rows[0]!.run_id,
  ]);
  await pool.query(
    "UPDATE goal_event SET state='completed',processed_at=now() WHERE wake_run_id=$1",
    [first.rows[0]!.run_id],
  );
  const races = await Promise.all([
    scanM02Schedules(pool, 'test', due),
    scanM02Schedules(pool, 'test', due),
  ]);
  expect(races.sort()).toEqual([0, 1]);
  const annual = await pool.query(
    `SELECT r.user_id,r.trigger_type,c.agent_code,r.max_data_level,p.version_id,
       m.message_json->>'content' AS briefing FROM goal_event e JOIN run r ON r.id=e.wake_run_id
       JOIN conversation c ON c.id=r.conversation_id JOIN run_rule_pack p ON p.run_id=r.id
       JOIN conversation_message m ON m.run_id=r.id WHERE e.source_key=$1`,
    [`m02:${goal}:annual:2027`],
  );
  expect(annual.rows).toEqual([
    {
      user_id: owner,
      trigger_type: 'wakeup',
      agent_code: 'maintenance',
      max_data_level: 'confidential',
      version_id: pack.versionId,
      briefing: expect.stringContaining('项目法域日期 2027-09-30'),
    },
  ]);
  await pool.query('UPDATE goal SET owner_user_id=$2 WHERE id=$1', [
    goal,
    context.userId('MEMBER_B'),
  ]);
  expect(await scanM02Schedules(pool, 'test', new Date('2027-11-01T15:00Z'))).toBe(0);
});
