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
  if (!['api', 'worker'].includes(kind)) throw new Error('仅支持api或worker启动方式。');
  const environment = Object.fromEntries(
    Object.entries(inherited).filter(([key]) => systemKeys.has(key.toUpperCase())),
  );
  const allowed = [
    ...baseKeys,
    ...(kind === 'worker' ? ['OPENROUTER_API_KEY', 'HTTPS_PROXY'] : []),
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
    kind === 'api' ? 'server.ts' : 'worker.ts',
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
