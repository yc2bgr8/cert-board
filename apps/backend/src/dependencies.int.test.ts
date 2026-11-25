import { parseBackendConfig } from '@cert-board/shared';
import { expect, test } from 'vitest';
import { createTestDatabase } from './db/test-database.js';
import { createDependencies } from './dependencies.js';

test('租出连接在查询之间断开时服务可以继续获取其它数据库连接', async () => {
  const fixture = await createTestDatabase();
  try {
    const config = parseBackendConfig(process.env);
    const { rows } = await fixture.pool.query<{ name: string }>(
      'SELECT current_database() AS name',
    );
    const url = new URL(config.TEST_DATABASE_URL);
    url.pathname = `/${rows[0]!.name}`;
    const dependencies = createDependencies({ ...config, DATABASE_URL: url.href });
    try {
      const client = await dependencies.database.connect();
      try {
        const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
          .pid;
        // 不注册测试专用的 error 监听，以免掩盖服务的连接生命周期缺陷。
        expect(client.listenerCount('error')).toBeGreaterThan(0);
        const disconnected = new Promise<void>((resolve) => client.once('end', resolve));
        const terminated = await fixture.pool.query<{ stopped: boolean }>(
          'SELECT pg_terminate_backend($1) AS stopped',
          [pid],
        );
        expect(terminated.rows[0]?.stopped).toBe(true);
        await disconnected;
        await expect(client.query('SELECT 1')).rejects.toThrow();
      } finally {
        client.release(true);
      }
      await expect(dependencies.checkDatabase()).resolves.toBeUndefined();
    } finally {
      await dependencies.close();
    }
  } finally {
    await fixture.dispose();
  }
});
