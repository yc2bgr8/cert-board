import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localProcessEnvironment, toWslPath } from './dev.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const windows = process.platform === 'win32';
const workspace = windows ? toWslPath(root) : root;
const image = 'cert-board-sandbox-test';

function docker(args) {
  const command = ['--context', 'default', ...args];
  return (
    spawnSync(
      windows ? 'wsl.exe' : 'docker',
      windows ? ['-d', 'Ubuntu-24.04', '--exec', 'docker', ...command] : command,
      { cwd: root, env: localProcessEnvironment(), stdio: 'inherit', windowsHide: true },
    ).status ?? 1
  );
}

const action = process.argv[2];
const operation = {
  up: ['up', '--detach', '--build', '--wait', '--wait-timeout', '90'],
  down: ['down'],
  status: ['ps'],
};
if (action === 'test') {
  process.exitCode =
    docker(['build', '--target', 'test', '-t', image, `${workspace}/apps/sandbox`]) ||
    docker([
      'run',
      '--rm',
      '--init',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--ipc',
      'none',
      '--pids-limit',
      '96',
      '--memory',
      '1g',
      '--cpus',
      '2',
      '--tmpfs',
      '/scratch:size=256m,nr_inodes=4096,uid=65532,gid=65532,mode=0700',
      image,
    ]);
} else if (Object.hasOwn(operation, action)) {
  process.exitCode = docker([
    'compose',
    '--project-directory',
    workspace,
    '--env-file',
    '/dev/null',
    '--file',
    `${workspace}/deploy/compose.sandbox.yml`,
    ...operation[action],
  ]);
} else {
  console.error('请使用 up、down、status 或 test。');
  process.exitCode = 1;
}
