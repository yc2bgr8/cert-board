import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { backendEnvironment } from './start-backend.mjs';

try {
  const local = parseEnv(await readFile(new URL('../.env.local', import.meta.url), 'utf8'));
  if (!local.OPENROUTER_API_KEY) {
    console.log('跳过真实模型测试：.env.local 未配置 OPENROUTER_API_KEY。');
  } else {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        process.argv.includes('--agent')
          ? 'apps/backend/src/agent/real-smoke.ts'
          : 'apps/backend/src/modelgw/real-smoke.ts',
      ],
      {
        cwd: new URL('..', import.meta.url),
        env: backendEnvironment('worker', local),
        stdio: 'inherit',
        windowsHide: true,
        shell: false,
      },
    );
    process.exitCode = await new Promise((resolve) => {
      child.once('error', () => {
        console.error('真实测试进程未能启动。');
        resolve(1);
      });
      child.once('close', (code) => resolve(code ?? 1));
    });
  }
} catch {
  console.error('真实测试配置无法读取，未输出配置或凭据。');
  process.exitCode = 1;
}
