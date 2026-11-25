import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { localProcessEnvironment } from './dev.mjs';

const sourceProject = 'cert-board-isolated';
const roles = {
  postgres: { volume: 'postgres_data', mount: '/var/lib/postgresql/data', image: 'pgvector/pgvector:0.8.1-pg16' },
  minio: { volume: 'minio_data', mount: '/data', image: 'pgsty/minio:RELEASE.2026-08-04T00-00-00Z' },
};
const dataRoles = Object.keys(roles);
const helperImage = 'pgvector/pgvector@sha256:33198da2828a14c30348d2ccb4750833d5ed9a44c88d840a0e523d7417120337';
const backupName = /^backup-\d{8}T\d{6}Z-[a-f0-9]{16}$/u;
const imageId = /^sha256:[a-f0-9]{64}$/u;
const digest = /^[a-f0-9]{64}$/u;
const archiveName = (role) => `${role}.tar`;
const volumeName = (project, role) => `${project}_${roles[role].volume}`;

const archiveVolume = `unexpected=$(find /volume ! -type d ! -type f -print -quit)
test -z "$unexpected"
exec tar --format=pax --numeric-owner --one-file-system -C /volume -cpf - .`;
const loadVolume = `test -z "$(ls -A /volume)"
exec tar --numeric-owner -xpf - -C /volume`;

function fail(message) {
  throw new Error(message);
}

function invocation(args) {
  return process.platform === 'win32'
    ? ['wsl.exe', ['-d', 'Ubuntu-24.04', '--exec', 'docker', '--context', 'default', ...args]]
    : ['docker', ['--context', 'default', ...args]];
}

function docker(args, message) {
  const [executable, command] = invocation(args);
  const result = spawnSync(executable, command, {
    encoding: 'utf8',
    env: localProcessEnvironment(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30_000,
  });
  if (result.status !== 0) fail(message);
  return result.stdout.trim();
}

function helper(volume, readOnly, command, input) {
  return [
    'run', '--rm', '--pull=never', '--network', 'none', '--read-only',
    '--security-opt', 'no-new-privileges', '--cap-drop', 'MKNOD', '--user', '0:0',
    ...(input ? ['-i'] : []),
    '--mount', `type=volume,source=${volume},target=/volume,volume-nocopy${readOnly ? ',readonly' : ''}`,
    '--entrypoint', 'sh', helperImage, '-eu', '-c', command,
  ];
}

function inspectVolume(project, role) {
  const name = volumeName(project, role);
  const value = JSON.parse(docker(['volume', 'inspect', '--format', '{{json .}}', name], '找不到预期的本地数据卷。'));
  if (
    value.Name !== name || value.Driver !== 'local' ||
    Object.keys(value.Options ?? {}).length !== 0 ||
    value.Labels?.['com.docker.compose.project'] !== project ||
    value.Labels?.['com.docker.compose.volume'] !== roles[role].volume
  )
    fail('数据卷与预期的本地 Compose 项目不符。');
  return name;
}

function stoppedSources() {
  return Object.fromEntries(dataRoles.map((role) => {
    const name = `${sourceProject}-${role}-1`;
    const volume = inspectVolume(sourceProject, role);
    const inspectFormat = [
      '{{.Id}}', '{{.Image}}', '{{.Config.Image}}', '{{.State.Status}}', '{{.State.ExitCode}}',
      '{{.State.StartedAt}}', '{{index .Config.Labels "com.docker.compose.project"}}',
      '{{index .Config.Labels "com.docker.compose.service"}}', '{{json .Mounts}}',
    ].join('\n');
    const [id, image, tag, state, exitCode, started, project, service, mounts] = docker(
      ['container', 'inspect', '--format', inspectFormat, name], '请保留停止后的数据库与文件存储容器。',
    ).split(/\r?\n/u);
    if (
      project !== sourceProject || service !== role || tag !== roles[role].image ||
      !imageId.test(image) || state !== 'exited' || !['0', '143'].includes(exitCode) ||
      !JSON.parse(mounts).some((entry) =>
        entry.Type === 'volume' && entry.Name === volume && entry.Destination === roles[role].mount)
    )
      fail('请先暂停工作台并正常停止数据库与文件存储，再执行备份。');
    if (docker(['ps', '-q', '--filter', `volume=${volume}`], '无法核对数据卷占用。'))
      fail('数据卷正在使用，请等使用该卷的容器完全停止。');
    return [role, { id, image, volume, started }];
  }));
}

function meter() {
  let bytes = 0;
  const hash = createHash('sha256');
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  return { stream, result: () => ({ bytes, sha256: hash.digest('hex') }) };
}

async function transfer(args, file, restore = false) {
  const [executable, command] = invocation(args);
  const child = spawn(executable, command, {
    env: localProcessEnvironment(),
    windowsHide: true,
    stdio: [restore ? 'pipe' : 'ignore', restore ? 'ignore' : 'pipe', 'ignore'],
  });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error('docker')));
  });
  const contents = meter();
  try {
    await Promise.all([
      closed,
      restore
        ? pipeline(createReadStream(file), contents.stream, child.stdin)
        : pipeline(child.stdout, contents.stream, createWriteStream(file, { flags: 'wx', mode: 0o600 })),
    ]);
  } catch {
    child.kill();
    fail(restore ? '恢复数据卷失败，目标卷保留以供核对。' : '数据卷归档失败，未发布备份。');
  }
  return contents.result();
}

export function validateBackupManifest(value) {
  if (
    value?.version !== 1 || value.project !== sourceProject ||
    Object.keys(value.archives ?? {}).length !== dataRoles.length
  )
    fail('备份清单版本或项目不受支持。');
  for (const role of dataRoles) {
    const entry = value.archives[role];
    if (
      entry?.file !== archiveName(role) || !imageId.test(entry.image) || !digest.test(entry.sha256) ||
      !Number.isSafeInteger(entry.bytes) || entry.bytes < 1
    )
      fail('备份清单缺少有效的文件校验或镜像编号。');
  }
  return value.archives;
}

async function prepareBackupRoot() {
  const local = fileURLToPath(new URL('../.local/', import.meta.url));
  const root = path.join(local, 'backups');
  for (const [directory, mode] of [[local, 0o022], [root, 0o077]]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (
      !stat.isDirectory() || stat.isSymbolicLink() ||
      (process.getuid && (stat.uid !== process.getuid() || (stat.mode & mode) !== 0))
    )
      fail('本机备份目录须由当前账号独占写入，并使用私有权限。');
  }
  return root;
}

async function assertRegular(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    fail('备份档案须使用普通文件。');
}

export async function verifyArchive(file, expected) {
  await assertRegular(file);
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256)
    fail('备份档案完整性校验失败。');
}

async function save(root) {
  const sources = stoppedSources();
  const initial = JSON.stringify(sources);
  docker(
    helper(sources.postgres.volume, true, "LC_ALL=C pg_controldata /volume | grep -Eq '^Database cluster state:[[:space:]]+shut down[[:space:]]*$'"),
    'PostgreSQL 未正常停库。',
  );
  const id = `backup-${new Date().toISOString().slice(0, 19).replace(/[-:]/gu, '')}Z-${randomBytes(8).toString('hex')}`;
  const staging = path.join(root, `.${id}.partial`);
  await mkdir(staging, { mode: 0o700 });
  const archives = {};
  for (const role of dataRoles) {
    if (JSON.stringify(stoppedSources()) !== initial) fail('备份期间源容器状态发生变化。');
    const source = sources[role];
    const file = archiveName(role);
    const contents = await transfer(helper(source.volume, true, archiveVolume), path.join(staging, file));
    archives[role] = { file, image: source.image, ...contents };
  }
  if (JSON.stringify(stoppedSources()) !== initial) fail('备份期间源容器状态发生变化。');
  const manifest = { version: 1, project: sourceProject, archives };
  validateBackupManifest(manifest);
  await writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx', mode: 0o600,
  });
  await rename(staging, path.join(root, id));
  console.log(`备份已生成。${id}`);
}

async function restore(root, id) {
  if (!backupName.test(id ?? '')) fail('请输入完整的备份编号。');
  const directory = path.join(root, id);
  const folder = await lstat(directory);
  if (!folder.isDirectory() || folder.isSymbolicLink()) fail('备份目录无效。');
  const manifest = path.join(directory, 'manifest.json');
  await assertRegular(manifest);
  const archives = validateBackupManifest(JSON.parse(await readFile(manifest, 'utf8')));
  for (const role of dataRoles) {
    const entry = archives[role];
    await verifyArchive(path.join(directory, entry.file), entry);
    const actual = docker(['image', 'inspect', '--format', '{{.Id}}', roles[role].image], '本机缺少备份所用的服务镜像。');
    if (actual !== entry.image) fail('本机服务镜像与备份来源不同，请使用同版本镜像。');
  }
  const project = `cert-board-restore-${randomBytes(8).toString('hex')}`;
  if (docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`], '无法核对恢复项目。'))
    fail('恢复项目编号冲突。');
  console.log(`恢复项目。${project}`);
  for (const role of dataRoles) {
    const volume = volumeName(project, role);
    docker([
      'volume', 'create', '--label', `com.docker.compose.project=${project}`,
      '--label', `com.docker.compose.volume=${roles[role].volume}`, volume,
    ], '无法创建恢复卷。');
    inspectVolume(project, role);
    const entry = archives[role];
    const restored = await transfer(helper(volume, false, loadVolume, true), path.join(directory, entry.file), true);
    if (restored.bytes !== entry.bytes || restored.sha256 !== entry.sha256)
      fail('恢复期间档案发生变化，目标卷保留以供核对。');
  }
  console.log('两个数据卷已恢复。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, id, extra] = process.argv.slice(2);
    if (extra || (action === 'save' && id) || !['save', 'restore'].includes(action))
      fail('用法为 pnpm backup:save 或 pnpm backup:restore <备份编号>。');
    const root = await prepareBackupRoot();
    if (action === 'save') await save(root);
    else await restore(root, id);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    console.error(/^[\p{Script=Han}]/u.test(message) ? message : '备份操作未完成，请核对目录和本地 Docker。');
    process.exitCode = 1;
  }
}
