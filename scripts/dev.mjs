import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const requiredVariables = ['POSTGRES_PASSWORD', 'MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD'];
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
  };
  if (!Object.hasOwn(operations, action)) {
    throw new Error('未知操作。请使用 up、down 或 status；脚本只管理 cert-board 项目。');
  }
  const missing = requiredVariables.filter((key) => !credentials[key]);
  if (missing.length)
    throw new Error(`缺少配置：${missing.join('、')}。请补充仓库 .env.local 后重试。`);
  const environment = Object.fromEntries(
    Object.entries(inheritedEnvironment).filter(([key]) => runtimeVariables.has(key.toUpperCase())),
  );
  for (const key of requiredVariables) environment[key] = credentials[key];
  const projectDirectory = platform === 'win32' ? toWslPath(root) : path.resolve(root);
  const composeFile = `${projectDirectory.replace(/\/$/, '')}/deploy/compose.dev.yml`;
  const args = [
    'compose',
    '--project-name',
    'cert-board',
    '--project-directory',
    projectDirectory,
    '--env-file',
    '/dev/null',
    '--file',
    composeFile,
    ...operations[action],
  ];
  if (platform === 'win32') {
    // WSLENV 仅传递三个必需配置，密钥不进入命令行参数。
    environment.WSLENV = requiredVariables.join(':');
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
  const invocation = composeInvocation(action, root, process.platform, credentials);
  console.log(`正在执行 cert-board 本地依赖服务操作：${action}。`);
  return await new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, {
      cwd: root,
      env: invocation.environment,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // 保留未结束的行，避免凭据被流分块切断后绕过脱敏。
    const drain = (stream, destination) => {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        pending += chunk;
        const boundary = pending.lastIndexOf('\n');
        if (boundary !== -1) {
          destination.write(redactOutput(pending.slice(0, boundary + 1), credentials));
          pending = pending.slice(boundary + 1);
        }
      });
      stream.on('end', () => {
        if (pending) destination.write(redactOutput(pending, credentials));
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
