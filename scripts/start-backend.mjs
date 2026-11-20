import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const baseKeys = [
  'NODE_ENV',
  'HOST',
  'PORT',
  'LOG_LEVEL',
  'WEB_ORIGIN',
  'SESSION_TTL_HOURS',
  'EXTERNAL_MODEL_MONTHLY_USD',
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'MINIO_ENDPOINT',
  'MINIO_PORT',
  'MINIO_USE_SSL',
  'MINIO_ROOT_USER',
  'MINIO_ROOT_PASSWORD',
  'MINIO_BUCKET',
];
const systemKeys = new Set([
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

export function backendEnvironment(kind, local, inherited = process.env) {
  if (!['api', 'worker', 'verification'].includes(kind))
    throw new Error('仅支持 api、worker 或 verification 启动方式。');
  const environment = Object.fromEntries(
    Object.entries(inherited).filter(([key]) => systemKeys.has(key.toUpperCase())),
  );
  const allowed = [
    ...baseKeys,
    ...(kind !== 'api'
      ? ['OPENROUTER_API_KEY', 'HTTPS_PROXY', 'CERT_LOCAL_MODEL_BASE_URL', 'CERT_DEV_MODEL_ID']
      : []),
    ...(kind === 'verification'
      ? ['CERT_CURSOR_BUNDLE', 'CERT_CURSOR_PROFILE', 'CERT_CURSOR_PRIVACY_CONFIRMED']
      : []),
    ...(kind === 'worker' || kind === 'verification'
      ? ['CERT_FETCHER_URL', 'CERT_WEB_EXTENDED_HOSTS']
      : []),
    ...(kind !== 'verification' ? ['CERT_DOCSVC_URL'] : []),
    ...(kind === 'worker' ? ['CERT_SANDBOX_URL'] : []),
  ];
  for (const key of allowed) if (local[key] !== undefined) environment[key] = local[key];
  return environment;
}

export async function startBackend(kind) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const local = parseEnv(await readFile(path.join(root, '.env.local'), 'utf8'));
  const environment = backendEnvironment(kind, local);
  const entry = path.join(
    root,
    'apps',
    'backend',
    'src',
    { api: 'server.ts', worker: 'worker.ts', verification: 'verification-worker.ts' }[kind],
  );
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    cwd: root,
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
    shell: false,
  });
  process.once('SIGINT', () => child.kill('SIGINT'));
  process.once('SIGTERM', () => child.kill('SIGTERM'));
  return await new Promise((resolve) => {
    child.once('error', () => {
      console.error('后端进程未能启动，请检查依赖和配置。');
      resolve(1);
    });
    child.once('close', (code) => resolve(code ?? 1));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await startBackend(process.argv[2]);
  } catch {
    console.error('启动配置无法读取，请检查 .env.local 和启动方式；未输出配置内容。');
    process.exitCode = 1;
  }
}
