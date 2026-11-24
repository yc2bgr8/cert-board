import pg from 'pg';
import { parseBackendConfig } from '@cert-board/shared';
import { seedDevelopmentRulePack } from './rule-packs.js';

async function main() {
  const config = parseBackendConfig(process.env);
  if (config.NODE_ENV === 'production' || process.argv.length > 3)
    throw new Error('KNOWLEDGE_SEED_DEVELOPMENT_ONLY');
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1 });
  try {
    const result = await seedDevelopmentRulePack(pool, config.NODE_ENV, process.argv[2]);
    console.log(result.created ? '已发布待确认的开发规则包。' : '相同开发规则包已就绪。');
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  console.error('规则包未发布，请核对开发环境、数据库迁移、种子字段和版本。');
  process.exitCode = 1;
});
