import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, expect, test } from 'vitest';
import { createApp } from '../app.js';
import { seedDevelopmentRulePack } from '../knowledge/rule-packs.js';
import { finishAbandonedAgentRun } from '../queue/agent-queue.js';
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
    available: true,
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

test('正式环境不给计划显示为可启用，现有设置仍可停用', async () => {
  const { pool, owner, goal } = await setup();
  const { headers } = await context.login();
  const url = `/api/goals/${goal}/m02-schedule`;
  const post = (app: ReturnType<typeof createApp>, enabled: boolean, expectedVersion: number) =>
    app.inject({
      method: 'POST',
      url,
      headers,
      payload: { enabled, expectedVersion },
    });
  expect((await post(context.app, true, 0)).statusCode).toBe(200);
  await pool.query('UPDATE app_user SET is_development=false WHERE id=$1', [owner]);
  const production = createApp(
    { ...context.config, NODE_ENV: 'production' },
    {
      database: pool,
      checkDatabase: async () => undefined,
      checkStorage: async () => undefined,
      close: async () => undefined,
    },
  );
  try {
    expect((await production.inject({ url, headers })).json()).toMatchObject({
      available: false,
      enabled: true,
    });
    expect((await post(production, false, 1)).json()).toMatchObject({
      available: false,
      enabled: false,
      version: 2,
    });
    const refused = await post(production, true, 2);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: 'M02_SCHEDULE_UNAVAILABLE' } });
    expect(await scanM02Schedules(pool, 'production')).toBe(0);
  } finally {
    await production.close();
  }
});

test('重新启用时补做同一窗口中尚未启动的失败，已取得运行权的核查不重复', async () => {
  const { pool, goal } = await setup();
  const { headers } = await context.login();
  const url = `/api/goals/${goal}/m02-schedule`;
  const post = (enabled: boolean, expectedVersion: number) =>
    context.app.inject({
      method: 'POST',
      url,
      headers,
      payload: { enabled, expectedVersion },
    });
  const today = new Date('2027-10-02T18:00Z');
  const events = async () =>
    (
      await pool.query<{ id: string; wake_run_id: string; state: string; source_key: string }>(
        'SELECT id,wake_run_id,state,source_key FROM goal_event WHERE goal_id=$1 ORDER BY source_key',
        [goal],
      )
    ).rows;
  expect((await post(true, 0)).statusCode).toBe(200);
  expect(await scanM02Schedules(pool, 'test', today)).toBe(1);
  const initial = await events();
  expect(initial).toHaveLength(2);
  expect((await post(false, 1)).statusCode).toBe(200);
  expect((await post(true, 2)).statusCode).toBe(200);
  expect(await finishAbandonedAgentRun(pool, initial[0]!.wake_run_id, true)).toBe(true);
  expect((await events()).every(({ state }) => state === 'cancelled')).toBe(true);
  expect(await scanM02Schedules(pool, 'test', today)).toBe(0);
  expect((await post(false, 3)).statusCode).toBe(200);
  expect((await post(true, 4)).statusCode).toBe(200);
  const attempts = await Promise.all([
    scanM02Schedules(pool, 'test', today),
    scanM02Schedules(pool, 'test', today),
  ]);
  expect(attempts.sort()).toEqual([0, 1]);
  const resumed = await events();
  expect(resumed.map(({ id }) => id)).toEqual(initial.map(({ id }) => id));
  expect(resumed[0]!.wake_run_id).not.toBe(initial[0]!.wake_run_id);
  await pool.query('UPDATE run SET lease_generation=1 WHERE id=$1', [resumed[0]!.wake_run_id]);
  expect(await finishAbandonedAgentRun(pool, resumed[0]!.wake_run_id, true)).toBe(true);
  expect((await post(false, 5)).statusCode).toBe(200);
  expect((await post(true, 6)).statusCode).toBe(200);
  expect(await scanM02Schedules(pool, 'test', today)).toBe(0);
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

test.each(['workspace', 'project'] as const)(
  '定时扫描等待并发 %s 的数据级别或关闭状态提交',
  async (change) => {
    const { pool, goal, project, workspace } = await setup();
    const { headers } = await context.login();
    const started = await context.app.inject({
      method: 'POST',
      url: `/api/goals/${goal}/m02-schedule`,
      headers,
      payload: { enabled: true, expectedVersion: 0 },
    });
    expect(started.statusCode).toBe(200);
    const tx = await pool.connect();
    let scanner: Promise<number> | undefined;
    try {
      await tx.query('BEGIN');
      if (change === 'workspace')
        await tx.query("UPDATE workspace SET data_level='confidential' WHERE id=$1", [workspace]);
      else await tx.query("UPDATE cert_project SET status='closed' WHERE id=$1", [project]);
      const {
        rows: [row],
      } = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      scanner = scanM02Schedules(pool, 'test', new Date('2027-11-02T15:00Z'));
      const deadline = Date.now() + 3000;
      let locked = false;
      while (!locked && Date.now() < deadline) {
        const { rows } = await pool.query(
          `SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))`,
          [row!.pid],
        );
        locked = rows.length > 0;
        if (!locked) await wait(20);
      }
      expect(locked).toBe(true);
      await tx.query('COMMIT');
      expect(await scanner).toBe(change === 'workspace' ? 1 : 0);
      const { rows } = await pool.query('SELECT max_data_level FROM run WHERE goal_id=$1', [goal]);
      expect(rows).toEqual(change === 'workspace' ? [{ max_data_level: 'confidential' }] : []);
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
      await scanner?.catch(() => undefined);
    }
  },
);
