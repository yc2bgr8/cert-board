import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { parseBackendConfig } from '@cert-board/shared';

export async function createTestDatabase() {
  if (process.env.NODE_ENV !== 'test') throw new Error('临时测试库只允许在测试环境建立。');
  const config = parseBackendConfig(process.env);
  const testUrl = new URL(config.TEST_DATABASE_URL);
  const databaseName = `cert_${randomBytes(12).toString('hex')}_test`;
  if (!/^cert_[a-f0-9]{24}_test$/.test(databaseName)) throw new Error('临时测试库名称校验失败。');
  const admin = new pg.Pool({ connectionString: testUrl.href, max: 1 });
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
  testUrl.pathname = `/${databaseName}`;
  const pool = new pg.Pool({ connectionString: testUrl.href, max: 5 });
  let closing: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;
  return {
    pool,
    dispose() {
      disposal ??= (async () => {
        await (closing ??= pool.end());
        const cleanup = new pg.Pool({ connectionString: config.TEST_DATABASE_URL, max: 1 });
        try {
          // 名称由本函数随机生成且严格校验，仅删除本次创建的测试库。
          await cleanup.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
        } finally {
          await cleanup.end();
        }
      })().catch((error: unknown) => {
        disposal = undefined;
        throw error;
      });
      return disposal;
    },
  };
}
