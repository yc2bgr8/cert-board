import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

try {
  const local = parseEnv(readFileSync('.env.local', 'utf8'));
  if (!local.TEST_DATABASE_URL) throw new Error();
  const port = Number(process.env.CERT_E2E_PORT ?? '28080');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error();
  const unused = new URL(local.TEST_DATABASE_URL);
  unused.pathname = '/cert_browser_unused';
  const system = new Set([
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'HOME',
    'LANG',
  ]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => system.has(key.toUpperCase())),
  );
  Object.assign(env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WEB_ORIGIN: `http://127.0.0.1:${port}`,
    DATABASE_URL: unused.href,
    TEST_DATABASE_URL: local.TEST_DATABASE_URL,
    MINIO_ENDPOINT: '127.0.0.1',
    MINIO_PORT: '29000',
    MINIO_USE_SSL: 'false',
    MINIO_ROOT_USER: 'browser-fixture',
    MINIO_ROOT_PASSWORD: 'browser-fixture-unused',
    MINIO_BUCKET: 'cert-board',
  });
  if (process.env.CERT_E2E_DIST) {
    const dist = path.resolve(process.env.CERT_E2E_DIST);
    const relative = path.relative(process.cwd(), dist);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error();
    env.BROWSER_FIXTURE_DIST = dist;
  }
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'apps/backend/src/e2e/browser.e2e.ts'],
    {
      env,
      stdio: 'inherit',
      windowsHide: true,
      shell: false,
    },
  );
  process.exitCode = result.status ?? 1;
} catch {
  console.error('浏览器验收未启动：请检查本地测试数据库配置；未读取或传递模型凭据。');
  process.exitCode = 1;
}
