import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { backendEnvironment } from './start-backend.mjs';
import { localProcessEnvironment } from './dev.mjs';

try {
  const official = process.argv.includes('--official');
  const cx = process.argv.includes('--cx');
  const certLine = process.argv.includes('--cert-line');
  if (certLine && (official || cx || process.argv.includes('--agent') || process.argv.includes('--l08')))
    throw new Error('认证线真实评测应单独运行。');
  const local = official
    ? {}
    : parseEnv(await readFile(new URL('../.env.local', import.meta.url), 'utf8'));
  if (!official && !local.OPENROUTER_API_KEY) {
    if (cx || certLine) {
      console.error('专项真实评测未通过。请在独立客体核对已授权模型配置。');
      process.exitCode = 1;
    } else {
      console.log('跳过真实模型测试：.env.local 未配置 OPENROUTER_API_KEY。');
    }
  } else {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        official
          ? 'apps/backend/src/official/real-smoke.ts'
          : process.argv.includes('--agent') || process.argv.includes('--l08')
            ? 'apps/backend/src/agent/real-smoke.ts'
            : 'apps/backend/src/modelgw/real-smoke.ts',
        ...(process.argv.includes('--l08') ? ['--l08'] : []),
        ...(official && process.argv.includes('--m02') ? ['--m02'] : []),
        ...(cx ? ['--cx'] : []),
        ...(certLine ? ['--cert-line'] : []),
      ],
      {
        cwd: new URL('..', import.meta.url),
        env: official ? localProcessEnvironment() : backendEnvironment('worker', local),
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
