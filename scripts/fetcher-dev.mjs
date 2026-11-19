import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localProcessEnvironment, toWslPath } from './dev.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const windows = process.platform === 'win32';
const workspace = windows ? toWslPath(root) : root;
const action = process.argv[2];
const base = ['--context', 'default'];
const project = [
  'compose',
  '--project-name',
  'cert-board-fetcher',
  '--project-directory',
  workspace,
  '--env-file',
  '/dev/null',
  '--file',
  `${workspace}/deploy/compose.fetcher.yml`,
];

function docker(args) {
  const environment = localProcessEnvironment();
  if (process.env.CERT_SEARXNG_ENABLED === '1') {
    environment.CERT_SEARXNG_ENABLED = '1';
    if (windows) environment.WSLENV = 'CERT_SEARXNG_ENABLED';
  }
  return (
    spawnSync(
      windows ? 'wsl.exe' : 'docker',
      windows ? ['-d', 'Ubuntu-24.04', '--exec', 'docker', ...base, ...args] : [...base, ...args],
      { cwd: root, env: environment, stdio: 'inherit', windowsHide: true },
    ).status ?? 1
  );
}

if (action === 'test') {
  const image = 'cert-board-fetcher-test';
  process.exitCode = docker([
    'build',
    '--target',
    'test',
    '-t',
    image,
    `${workspace}/apps/fetcher`,
  ]);
  if (process.exitCode === 0)
    process.exitCode = docker(['run', '--rm', '--network', 'none', image]);
} else {
  const options = {
    up: ['up', '--detach', '--build', '--wait', '--wait-timeout', '90'],
    down: ['down'],
    status: ['ps'],
  };
  if (!Object.hasOwn(options, action)) {
    console.error('请使用 up、down、status 或 test。');
    process.exitCode = 1;
  } else process.exitCode = docker([...project, ...options[action]]);
}
