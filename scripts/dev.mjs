import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const requiredVariables = ['POSTGRES_PASSWORD', 'MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD'];
const developmentPasswordFields = [
  'DEV_ZHANGSAN_PASSWORD',
  'DEV_WANGMIN_PASSWORD',
  'DEV_ADMIN_PASSWORD',
];
const runtimeVariables = new Set([
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
  'PROGRAMDATA',
  'HOME',
  'LANG',
  'LC_ALL',
]);

export function localProcessEnvironment(inherited = process.env) {
  return Object.fromEntries(
    Object.entries(inherited).filter(([key]) => runtimeVariables.has(key.toUpperCase())),
  );
}

export function toWslPath(windowsPath) {
  const match = /^([a-z]):[\\/](.*)$/i.exec(windowsPath);
  if (!match || ['\r', '\n', '\0'].some((control) => windowsPath.includes(control))) {
    throw new Error('仓库路径必须是带盘符的 Windows 绝对路径；不支持 UNC 路径。');
  }
  const normalized = path.win32.normalize(windowsPath).replace(/\\/g, '/');
  return `/mnt/${match[1].toLowerCase()}/${normalized.slice(3)}`;
}

export function composeInvocation(
  action,
  root,
  platform,
  credentials,
  inheritedEnvironment = process.env,
) {
  const operations = {
    up: ['up', '--detach', '--wait', '--wait-timeout', '120'],
    down: ['down'],
    status: ['ps'],
    'preview-up': ['up', '--detach', '--wait', '--wait-timeout', '120'],
    'isolated-up': ['up', '--detach', '--build', '--wait', '--wait-timeout', '120'],
    'isolated-web-up': ['up', '--detach', '--build', '--wait', '--wait-timeout', '120'],
    'isolated-down': ['--profile', 'network-check', 'down'],
    'isolated-web-down': ['--profile', 'network-check', 'down'],
    'isolated-status': ['--profile', 'network-check', 'ps'],
    'isolated-accounts': [
      'exec',
      '-T',
      'backend-api',
      'node',
      '--import',
      'tsx',
      'apps/backend/src/db/cli.ts',
      'isolated-accounts',
    ],
    'isolated-check': [
      '--profile',
      'network-check',
      'up',
      '--detach',
      '--build',
      '--wait',
      '--wait-timeout',
      '60',
      'probe-relay',
    ],
  };
  if (!Object.hasOwn(operations, action)) {
    throw new Error('未知操作。请使用 up、down、status 或对应的 isolated 操作。');
  }
  const isolated = action.startsWith('isolated-');
  const preview = action === 'preview-up';
  const withFetcher = action.startsWith('isolated-web-');
  const required = preview ? ['POSTGRES_PASSWORD'] : requiredVariables;
  const missing = required.filter((key) => !credentials[key]);
  if (missing.length)
    throw new Error(`缺少配置：${missing.join('、')}。请补充仓库 .env.local 后重试。`);
  const environment = localProcessEnvironment(inheritedEnvironment);
  for (const key of required) environment[key] = credentials[key];
  const passedVariables = [...required];
  if (isolated) {
    const port = inheritedEnvironment.CERT_ISOLATED_WEB_PORT ?? '28080';
    if (!['28080', '28186'].includes(port))
      throw new Error('容器部署仅使用回环端口 28080 或 28186。');
    environment.CERT_ISOLATED_WEB_PORT = port;
    environment.CERT_DB_PASSWORD_URI = encodeURIComponent(credentials.POSTGRES_PASSWORD);
    passedVariables.push('CERT_ISOLATED_WEB_PORT', 'CERT_DB_PASSWORD_URI');
    if (['isolated-up', 'isolated-web-up'].includes(action) && credentials.OPENROUTER_API_KEY) {
      environment.OPENROUTER_API_KEY = credentials.OPENROUTER_API_KEY;
      passedVariables.push('OPENROUTER_API_KEY');
    }
    if (withFetcher && inheritedEnvironment.CERT_SEARXNG_ENABLED === '1') {
      environment.CERT_SEARXNG_ENABLED = '1';
      passedVariables.push('CERT_SEARXNG_ENABLED');
    }
  }
  const projectDirectory = platform === 'win32' ? toWslPath(root) : path.resolve(root);
  const profile = isolated ? 'isolated' : preview ? 'preview' : 'dev';
  const composeFile = `${projectDirectory.replace(/\/$/, '')}/deploy/compose.${profile}.yml`;
  const args = [
    ...(isolated ? ['--context', 'default'] : []),
    'compose',
    '--project-name',
    isolated ? 'cert-board-isolated' : preview ? 'cert-board-preview' : 'cert-board',
    '--project-directory',
    projectDirectory,
    '--env-file',
    '/dev/null',
    '--file',
    composeFile,
    ...(withFetcher
      ? [
          '--file',
          `${projectDirectory}/deploy/compose.fetcher.yml`,
          '--file',
          `${projectDirectory}/deploy/compose.fetcher-isolated.yml`,
          '--file',
          `${projectDirectory}/deploy/compose.docsvc.yml`,
          '--file',
          `${projectDirectory}/deploy/compose.docsvc-isolated.yml`,
          '--file',
          `${projectDirectory}/deploy/compose.sandbox.yml`,
          '--file',
          `${projectDirectory}/deploy/compose.sandbox-isolated.yml`,
        ]
      : []),
    ...operations[action],
  ];
  if (platform === 'win32') {
    // 只传递对应模式的配置，凭据不进入命令行参数。
    environment.WSLENV = passedVariables.join(':');
    return {
      executable: 'wsl.exe',
      args: ['-d', 'Ubuntu-24.04', '--exec', 'docker', ...args],
      environment,
    };
  }
  return { executable: 'docker', args, environment };
}

export function redactOutput(output, credentials) {
  let sanitized = output;
  for (const value of Object.values(credentials)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)) {
    sanitized = sanitized.replaceAll(value, '[已脱敏]');
  }
  return sanitized;
}

export async function runDev(
  action,
  root = path.resolve(fileURLToPath(new URL('..', import.meta.url))),
) {
  let values;
  try {
    values = parseEnv(await readFile(path.join(root, '.env.local'), 'utf8'));
  } catch {
    throw new Error('无法读取仓库 .env.local。请按 .env.example 配置本地依赖服务后重试。');
  }
  const credentials = Object.fromEntries(requiredVariables.map((key) => [key, values[key]]));
  if (['isolated-up', 'isolated-web-up'].includes(action))
    credentials.OPENROUTER_API_KEY = values.OPENROUTER_API_KEY;
  const invocation = composeInvocation(action, root, process.platform, credentials);
  if (action.startsWith('isolated-'))
    credentials.CERT_DB_PASSWORD_URI = invocation.environment.CERT_DB_PASSWORD_URI;
  const accounts =
    action === 'isolated-accounts'
      ? Object.fromEntries(developmentPasswordFields.map((key) => [key, values[key]]))
      : undefined;
  const secrets = { ...credentials, ...accounts };
  console.log(`正在执行 cert-board 本地依赖服务操作：${action}。`);
  return await new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, {
      cwd: root,
      env: invocation.environment,
      shell: false,
      windowsHide: true,
      stdio: [accounts ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    if (accounts && child.stdin) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(JSON.stringify(accounts));
    }
    // 保留未结束的行，避免凭据被流分块切断后绕过脱敏。
    const drain = (stream, destination) => {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        pending += chunk;
        const boundary = pending.lastIndexOf('\n');
        if (boundary !== -1) {
          destination.write(redactOutput(pending.slice(0, boundary + 1), secrets));
          pending = pending.slice(boundary + 1);
        }
      });
      stream.on('end', () => {
        if (pending) destination.write(redactOutput(pending, secrets));
      });
    };
    drain(child.stdout, process.stdout);
    drain(child.stderr, process.stderr);
    child.once('error', () =>
      reject(
        new Error(
          '无法启动 Docker。Windows 请检查 Ubuntu-24.04 的 WSL 与 Docker，Linux 请检查 docker 命令。',
        ),
      ),
    );
    child.once('close', (code) => resolve(code ?? 1));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runDev(process.argv[2] ?? 'up');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
