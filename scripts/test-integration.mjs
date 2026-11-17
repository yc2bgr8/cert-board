import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';

let local = {};
try {
  local = parseEnv(readFileSync('.env.local', 'utf8'));
} catch {
  console.error('缺少 .env.local，请先运行 pnpm env:init 和 pnpm dev:up。');
  process.exit(1);
}
const allowed = [
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'MINIO_ENDPOINT',
  'MINIO_PORT',
  'MINIO_USE_SSL',
  'MINIO_ROOT_USER',
  'MINIO_ROOT_PASSWORD',
  'MINIO_BUCKET',
];
const environment = { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' };
// 集成测试不继承模型凭据，真实模型另走专用测试入口。
for (const key of Object.keys(environment))
  if (/(?:KEY|TOKEN|SECRET)$/.test(key)) delete environment[key];
for (const key of allowed) if (local[key]) environment[key] = local[key];
const result = spawnSync(
  process.execPath,
  ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.integration.config.ts'],
  {
    stdio: 'inherit',
    env: environment,
  },
);
process.exitCode = result.status ?? 1;
