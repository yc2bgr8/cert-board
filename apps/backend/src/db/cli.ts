import pg from 'pg';
import { ConfigurationError, parseBackendConfig, SeedConfigurationError } from '@cert-board/shared';
import { migrateDatabase, MigrationError } from './migrate.js';
import { DevelopmentSeedError, seedDevelopmentAccounts } from './seed.js';

async function main() {
  const action = process.argv[2];
  if (!['migrate', 'seed', 'setup'].includes(action ?? '')) throw new Error('unknown_action');
  const config = parseBackendConfig(process.env);
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1 });
  try {
    if (action === 'migrate' || action === 'setup') {
      const result = await migrateDatabase(pool);
      console.log(`数据库迁移完成：本次应用${result.applied.length}个版本。`);
    }
    if (action === 'seed' || action === 'setup') {
      const result = await seedDevelopmentAccounts(pool, process.env);
      console.log(
        `开发账号种子完成：新建${result.created.length}个，保留已有${result.unchanged.length}个。密码只保存在 .env.local。`,
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof ConfigurationError ||
      error instanceof SeedConfigurationError ||
      error instanceof MigrationError ||
      error instanceof DevelopmentSeedError
      ? error.message
      : '数据库操作失败，请检查依赖服务、迁移文件和配置。未输出底层连接或输入内容。',
  );
  process.exitCode = 1;
});
