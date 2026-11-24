import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

function run(script, ...args) {
  return spawnSync('pnpm', [script, ...args], { cwd: root, stdio: 'inherit' }).status ?? 1;
}

async function main() {
  const marker = await readFile('/etc/cert-board-acceptance-vm', 'utf8').catch(() => '');
  if (process.platform !== 'linux' || marker.trim() !== 'cert-board-acceptance')
    throw new Error('官方专项应在独立 Linux 验收虚拟机运行。');
  const m02 = process.argv.includes('--m02');
  let status;
  try {
    status =
      run('dev:fetcher:up') ||
      (m02 ? 0 : run('test:real', '--official')) ||
      run('walkthrough:real', m02 ? '--m02-only' : '--official-only');
  } finally {
    const stopped = run('dev:fetcher:down');
    process.exitCode = status || stopped;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : '官方数据专项失败。');
  process.exitCode = 1;
});
