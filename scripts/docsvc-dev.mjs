import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { localProcessEnvironment, toWslPath } from './dev.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const windows = process.platform === 'win32';
const mountPath = (value) => (windows ? toWslPath(value) : value);
const workspace = mountPath(root);
const image = 'cert-board-docsvc-test';
const runtimeFlags = [
  '--rm',
  '--network',
  'none',
  '--memory',
  '2g',
  '--cpus',
  '2',
  '--pids-limit',
  '128',
];

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

function buildTestImage() {
  return docker(['build', '--target', 'test', '-t', image, `${workspace}/apps/docsvc`]);
}

function compareL08() {
  const envPath = path.join(root, '.env.local');
  const local = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
  const source = process.env.CERT_DATA_DIR ?? local.CERT_DATA_DIR;
  const reference = process.env.CERT_REF_DIR ?? local.CERT_REF_DIR;
  if (!source || !reference) {
    console.log('已跳过 L08 实物对照。请在本机提供 CERT_DATA_DIR 和 CERT_REF_DIR。');
    return 0;
  }
  const inputDir = path.resolve(source, 'l08', '510k');
  const t1 = path.resolve(reference, 'sources', 't1_parse', 'out');
  if (!statSync(inputDir, { throwIfNoEntry: false })?.isDirectory()) {
    console.log('已跳过 L08 实物对照。本机未找到配置的 L08 资料目录。');
    return 0;
  }
  if (!['documents.json', 'pages.jsonl', 'estar_datasets.xml'].every((name) => existsSync(path.join(t1, name)))) {
    console.error('已找到 L08 原件，但 T1 对照结果不完整。');
    return 1;
  }
  const built = buildTestImage();
  return (
    built ||
    docker([
      'run',
      ...runtimeFlags,
      '--mount',
      `type=bind,source=${mountPath(inputDir)},target=/l08,readonly`,
      '--mount',
      `type=bind,source=${mountPath(t1)},target=/t1,readonly`,
      image,
      '/app/.venv/bin/python',
      '/app/compare_l08.py',
      '/l08',
      '/t1',
    ])
  );
}

const action = process.argv[2];
const options = {
  up: ['up', '--detach', '--build', '--wait', '--wait-timeout', '90'],
  down: ['down'],
  status: ['ps'],
};
if (action === 'test') {
  process.exitCode = buildTestImage() || docker(['run', ...runtimeFlags, image]);
} else if (action === 'l08') {
  process.exitCode = compareL08();
} else if (Object.hasOwn(options, action)) {
  process.exitCode = docker([
    'compose',
    '--project-directory',
    workspace,
    '--env-file',
    '/dev/null',
    '--file',
    `${workspace}/deploy/compose.docsvc.yml`,
    ...options[action],
  ]);
} else {
  console.error('请使用 up、down、status、test 或 l08。');
  process.exitCode = 1;
}
