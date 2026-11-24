import { existsSync } from 'node:fs';
import pg from 'pg';
import { ConfigurationError, parseBackendConfig, SeedConfigurationError } from '@cert-board/shared';
import { migrateDatabase, MigrationError } from './migrate.js';
import { DevelopmentSeedError, seedDevelopmentAccounts } from './seed.js';
import { seedDevelopmentProject } from '../projects/seed.js';
import { seedT1Documents } from '../documents/t1-seed.js';
import { BlobStore } from '../documents/blob-store.js';
import { createDependencies } from '../dependencies.js';
import { AppError } from '../api/errors.js';
import { seedDevelopmentWorkspace } from '../workspace/seed.js';
import { seedDevelopmentBudgetPolicy } from '../budget/service.js';
import { seedDevelopmentRulePack } from '../knowledge/rule-packs.js';

async function main() {
  const action = process.argv[2];
  if (!['migrate', 'seed', 'setup', 'isolated-accounts'].includes(action ?? ''))
    throw new Error('unknown_action');
  const config = parseBackendConfig(process.env);
  if (
    action === 'isolated-accounts' &&
    (config.CONTAINER_RUNTIME !== 'docker' ||
      !existsSync('/.dockerenv') ||
      new URL(config.DATABASE_URL).hostname !== 'postgres')
  )
    throw new Error('isolated_deployment_required');
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1 });
  try {
    if (action === 'isolated-accounts') {
      let input = '';
      for await (const piece of process.stdin.setEncoding('utf8')) {
        input += piece;
        if (Buffer.byteLength(input) > 4096) throw new Error('seed_input_limit');
      }
      const environment = JSON.parse(input) as Record<string, unknown>;
      const result = await seedDevelopmentAccounts(pool, {
        ...environment,
        NODE_ENV: config.NODE_ENV,
      });
      console.log(`隔离工作台账号已就绪，新增 ${result.created.length} 个。`);
    }
    if (action === 'migrate' || action === 'setup') {
      const result = await migrateDatabase(pool);
      console.log(`数据库迁移完成：本次应用${result.applied.length}个版本。`);
    }
    if (action === 'seed' || action === 'setup') {
      const result = await seedDevelopmentAccounts(pool, process.env);
      console.log(
        `开发账号种子完成：新建${result.created.length}个，保留已有${result.unchanged.length}个。密码只保存在 .env.local。`,
      );
      const project = await seedDevelopmentProject(pool, process.env);
      await seedDevelopmentBudgetPolicy(pool, config.NODE_ENV);
      await seedDevelopmentRulePack(pool, config.NODE_ENV);
      console.log('开发预算已就绪，保留已有额度、整晚批次和停止状态。');
      console.log(
        project.created
          ? 'L08开发项目及目标已建立，业务日期保持待确认。'
          : 'L08开发项目已存在，保留已有内容。',
      );
      const dependencies = createDependencies(config);
      try {
        const store = new BlobStore(dependencies.storage, config.MINIO_BUCKET);
        const documents = await seedT1Documents(pool, store, process.env);
        console.log(
          `T1解析快照已就绪：${documents.documentCount}份资料、${documents.pageCount}条逐页文本；未导入原始文件。`,
        );
        const workspace = await seedDevelopmentWorkspace(pool, store, process.env);
        console.log(
          workspace.created ? 'L08工作区初始版本已建立。' : 'L08工作区已存在，保留已有版本与改动。',
        );
      } finally {
        await dependencies.close();
      }
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
      error instanceof AppError ||
      error instanceof DevelopmentSeedError
      ? error.message
      : '数据库操作失败，请检查依赖服务、迁移文件和配置。未输出底层连接或输入内容。',
  );
  process.exitCode = 1;
});
