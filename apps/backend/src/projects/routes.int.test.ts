import { afterAll, beforeAll, expect, test } from 'vitest';
import { parseBackendConfig, projectListSchema, goalListSchema } from '@cert-board/shared';
import { createTestDatabase } from '../db/test-database.js';
import { migrateDatabase } from '../db/migrate.js';
import { seedDevelopmentAccounts } from '../db/seed.js';
import { seedDevelopmentProject, developmentProjectId } from './seed.js';
import { createApp } from '../app.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof createApp>;
const password = ['route', 'project', 'fixture', 'only'].join('-');
beforeAll(async () => {
  database = await createTestDatabase();
  await migrateDatabase(database.pool);
  await seedDevelopmentAccounts(database.pool, {
    NODE_ENV: 'test',
    ...Object.fromEntries(
      ['ZHANGSAN', 'WANGMIN', 'ADMIN'].map((role) => [`DEV_${role}_PASSWORD`, password]),
    ),
  });
  await seedDevelopmentProject(database.pool, { NODE_ENV: 'test' });
  const config = parseBackendConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' });
  app = createApp(config, {
    database: database.pool,
    checkDatabase: async () => undefined,
    checkStorage: async () => undefined,
    close: async () => undefined,
  });
});
afterAll(async () => {
  if (app) await app.close();
  if (database) await database.dispose();
});
async function session(username: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: 'http://127.0.0.1:28080', 'sec-fetch-site': 'same-origin' },
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return {
    cookie: String(response.headers['set-cookie']).split(';')[0] ?? '',
    'sec-fetch-site': 'same-origin',
  };
}

test('登录后可读取L08项目与目标，并保留未知业务期限', async () => {
  const headers = await session('zhangsan');
  const result = await app.inject({ url: '/api/projects', headers });
  expect(result.statusCode).toBe(200);
  expect(result.headers['cache-control']).toBe('no-store');
  const list = projectListSchema.parse(result.json());
  expect(list.items.map((p) => p.name)).toEqual(['L08 510(k)']);
  expect(list.items[0]?.targetAt).toBeNull();
  const goals = await app.inject({ url: `/api/projects/${developmentProjectId}/goals`, headers });
  expect(goals.statusCode).toBe(200);
  expect(goalListSchema.parse(goals.json()).items[0]?.dueAt).toBeNull();
  expect((await app.inject({ url: '/api/projects?limit=999', headers })).statusCode).toBe(400);
});

test('任一活动成员能读取项目，未登录拒绝且仍未开放浏览器业务写入口', async () => {
  expect(
    (await app.inject({ url: '/api/projects', headers: { 'sec-fetch-site': 'same-origin' } }))
      .statusCode,
  ).toBe(401);
  expect(
    (await app.inject({ url: '/api/projects', headers: await session('wangmin') })).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: await session('zhangsan'),
        payload: { name: '非法旁路' },
      })
    ).statusCode,
  ).toBe(404);
});
