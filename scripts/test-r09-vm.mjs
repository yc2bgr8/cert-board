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
    throw new Error('R09 专项应在独立 Linux 验收虚拟机运行。');
  process.exitCode =
    run('eval:r09') ||
    run('db:setup') ||
    run('test:real', '--cx') ||
    run('walkthrough:real', '--r09-only');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'R09 专项失败。');
  process.exitCode = 1;
});
