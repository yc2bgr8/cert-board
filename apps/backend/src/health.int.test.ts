import { afterAll, beforeAll, expect, test } from 'vitest';
import { parseBackendConfig } from '@cert-board/shared';
import { createDependencies } from './dependencies.js';
import { createApp } from './app.js';

let app: ReturnType<typeof createApp>;
let dependencies: ReturnType<typeof createDependencies>;

beforeAll(async () => {
  const config = parseBackendConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' });
  const testUrl = config.TEST_DATABASE_URL;
  if (
    !testUrl ||
    new URL(testUrl).pathname !== '/cert_board_test' ||
    testUrl === config.DATABASE_URL
  ) {
    throw new Error('集成测试必须使用独立的 cert_board_test 数据库。');
  }
  dependencies = createDependencies({ ...config, DATABASE_URL: testUrl });
  app = createApp(config, dependencies);
});

afterAll(async () => {
  if (app) await app.close();
});

test('独立测试库可连接，PostgreSQL版本和向量扩展符合要求', async () => {
  const result = await dependencies.database.query<{ database: string; version: string }>(
    "SELECT current_database() AS database, current_setting('server_version') AS version",
  );
  expect(result.rows[0]?.database).toBe('cert_board_test');
  expect(result.rows[0]?.version).toMatch(/^16\./);
  const vector = await dependencies.database.query(
    "SELECT name FROM pg_available_extensions WHERE name = 'vector'",
  );
  expect(vector.rowCount).toBe(1);
});

test('健康接口连通真实数据库和文件存储', async () => {
  const response = await app.inject('/health');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    status: 'ok',
    dependencies: { database: 'up', storage: 'up' },
  });
});
