import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { purgeExpiredModelRequests } from './request-retention.js';

async function main() {
  const local = parseEnv(
    await readFile(new URL('../../../../.env.local', import.meta.url), 'utf8'),
  );
  if (!local.DATABASE_URL) throw new Error('missing_database');
  const pool = new pg.Pool({ connectionString: local.DATABASE_URL, max: 1 });
  try {
    const result = await purgeExpiredModelRequests(pool);
    console.log(`已清理${result.deleted}条到期私有请求内容；审计只记录数量与编号哈希。`);
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error('请求内容清理未完成，请检查本地数据库与迁移；未输出原文或连接配置。');
  process.exitCode = 1;
});
