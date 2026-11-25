import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFile, cp, lstat, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeInvocation, localProcessEnvironment } from './dev.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const helper = 'pgvector/pgvector@sha256:33198da2828a14c30348d2ccb4750833d5ed9a44c88d840a0e523d7417120337';
const source = 'cert-board-isolated';
const system = localProcessEnvironment();
const require = createRequire(new URL('../apps/backend/package.json', import.meta.url));

function invoke(binary, args, stage, options = {}) {
  const result = spawnSync(binary, args, {
    env: system,
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
    ...options,
  });
  if (result.status !== 0) throw new Error(stage);
  return result.stdout.trim();
}

async function fixture(mode) {
  const container = await lstat('/.dockerenv');
  assert.ok(container.isFile(), '合成数据只能在本轮 Docker 探针中写入。');
  const chunks = [];
  for await (const data of process.stdin) chunks.push(data);
  const settings = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const pg = require('pg');
  const { Client } = require('minio');
  const url = `postgresql://cert_board:${encodeURIComponent(settings.POSTGRES_PASSWORD)}@postgres:5432/cert_board`;
  const testUrl = new URL(url);
  testUrl.pathname = '/cert_board_test';
  const storage = new Client({
    endPoint: 'minio', port: 9000, useSSL: false,
    accessKey: settings.MINIO_ROOT_USER, secretKey: settings.MINIO_ROOT_PASSWORD,
  });
  const bucket = 'cert-board';
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    if (mode === 'seed') {
      invoke(process.execPath, ['--import', 'tsx', 'apps/backend/src/db/cli.ts', 'migrate'], '应用数据库迁移失败。', {
        env: {
          ...system, NODE_ENV: 'development', CONTAINER_RUNTIME: 'docker',
          DATABASE_URL: url, TEST_DATABASE_URL: testUrl.href,
          MINIO_ENDPOINT: 'minio', MINIO_PORT: '9000', MINIO_USE_SSL: 'false',
          MINIO_ROOT_USER: settings.MINIO_ROOT_USER, MINIO_ROOT_PASSWORD: settings.MINIO_ROOT_PASSWORD,
        },
      });
      await pool.query('CREATE SCHEMA backup_drill; CREATE TABLE backup_drill.documents (sha256 text PRIMARY KEY)');
      await storage.makeBucket(bucket);
      for (const text of ['合成登记表', '合成留存文件']) {
        const bytes = Buffer.from(text);
        const hash = createHash('sha256').update(bytes).digest('hex');
        await storage.putObject(bucket, `sha256/${hash}`, bytes, bytes.length);
        await pool.query('INSERT INTO backup_drill.documents VALUES ($1)', [hash]);
      }
    }
    const { rows: tables } = await pool.query(`SELECT schemaname,tablename,
      format('%I.%I',schemaname,tablename) AS relation FROM pg_tables
      WHERE schemaname IN ('public','drizzle','backup_drill') ORDER BY schemaname,tablename`);
    const tableCounts = {};
    for (const { relation } of tables) {
      const { rows } = await pool.query(`SELECT count(*)::text AS count FROM ${relation}`);
      tableCounts[relation] = rows[0].count;
    }
    const blobs = {};
    for await (const object of storage.listObjectsV2(bucket, '', true)) {
      assert.match(object.name, /^sha256\/[a-f0-9]{64}$/u);
      const hash = createHash('sha256');
      const stream = await storage.getObject(bucket, object.name);
      for await (const chunk of stream) hash.update(chunk);
      const value = hash.digest('hex');
      assert.equal(object.name, `sha256/${value}`);
      blobs[object.name] = value;
    }
    assert.equal(tableCounts['backup_drill.documents'], '2');
    assert.equal(Object.keys(blobs).length, 2);
    assert.ok(Object.keys(tableCounts).length > 20);
    const { rows: records } = await pool.query('SELECT sha256 FROM backup_drill.documents ORDER BY sha256');
    assert.deepEqual(records.map((row) => row.sha256), Object.values(blobs).sort());
    console.log(JSON.stringify({ tableCounts, blobs }));
  } finally {
    await pool.end();
  }
}

async function drill() {
  assert.equal(process.platform, 'linux', '备份恢复演练须在专用 Linux 验收机运行。');
  const marker = '/etc/cert-board-acceptance-vm';
  const mark = await lstat(marker);
  assert.ok(mark.isFile() && mark.uid === 0 && (mark.mode & 0o022) === 0);
  assert.equal((await readFile(marker, 'utf8')).trim(), 'cert-board-acceptance');
  assert.equal(invoke('systemd-detect-virt', ['--vm'], '验收虚拟机标识无效。'), 'kvm');
  const docker = (args, stage, options) => invoke('docker', ['--context', 'default', ...args], stage, options);
  assert.equal(docker(['ps', '-aq'], '无法核对验收机里的容器。'), '', '请使用干净的验收机。');
  assert.equal(
    docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${source}`], '无法核对演练源数据卷。'),
    '', '演练源卷已经存在，请使用新的验收机。',
  );
  const settings = {
    POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
    MINIO_ROOT_USER: 'backup-drill',
    MINIO_ROOT_PASSWORD: randomBytes(24).toString('hex'),
  };
  const compose = (project, args, stage) => docker([
    'compose', '--env-file', '/dev/null', '--project-name', project,
    '--project-directory', root, '-f', path.join(root, 'deploy/compose.isolated.yml'), ...args,
  ], stage, {
    env: {
      ...system, ...settings, CERT_DB_PASSWORD_URI: encodeURIComponent(settings.POSTGRES_PASSWORD),
    },
  });
  const probe = (project, mode) => JSON.parse(docker([
    'run', '--rm', '--pull=never', '-i', '--network', `${project}_internal`,
    '--read-only', '--tmpfs', '/tmp:mode=1777', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--user', `${process.getuid()}:${process.getgid()}`,
    '--mount', `type=bind,source=${process.execPath},target=/tool/node,readonly`,
    '--mount', `type=bind,source=${root},target=/workspace,readonly`,
    '--workdir', '/workspace', '--entrypoint', '/tool/node',
    helper, '/workspace/scripts/test-backup.mjs', '--fixture', mode,
  ], mode === 'seed' ? '合成备份资料写入失败。' : '恢复后的业务数据核对失败。', {
    input: JSON.stringify(settings),
  }));
  const backup = (...args) => spawnSync(process.execPath, ['scripts/backup.mjs', ...args], {
    cwd: root, env: system, encoding: 'utf8', timeout: 180_000,
  });
  const volumes = () => docker(['volume', 'ls', '-q'], '无法核对恢复卷创建状态。').split('\n').sort();
  let target;
  try {
    compose(source, ['up', '-d', '--wait', 'postgres', 'minio'], '演练源数据服务启动失败。');
    const before = probe(source, 'seed');
    const running = backup('save');
    assert.equal(running.status, 1);
    assert.match(running.stderr, /正常停止数据库与文件存储/u);
    const stop = composeInvocation('isolated-stop', root, process.platform, settings, system);
    invoke(stop.executable, stop.args, '演练源数据服务正常关机失败。', { env: stop.environment });
    const saved = backup('save');
    if (saved.status !== 0) throw new Error(saved.stderr.trim() || '备份创建失败。');
    const id = saved.stdout.match(/backup-\d{8}T\d{6}Z-[a-f0-9]{16}/u)?.[0];
    assert.ok(id, '备份没有返回编号。');
    const good = path.join(root, '.local', 'backups', id);
    const badId = id.replace(/[a-f0-9]{16}$/u, randomBytes(8).toString('hex'));
    const bad = path.join(root, '.local', 'backups', badId);
    await cp(good, bad, { recursive: true, force: false, errorOnExist: true });
    await appendFile(path.join(bad, 'minio.tar'), Buffer.from('合成损坏'));
    const previous = volumes();
    const broken = backup('restore', badId);
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /档案完整性校验失败/u);
    assert.deepEqual(volumes(), previous, '损坏档案在验证前创建了目标卷。');

    const restored = backup('restore', id);
    target = restored.stdout.match(/cert-board-restore-[a-f0-9]{16}/u)?.[0];
    if (restored.status !== 0) throw new Error(restored.stderr.trim() || '恢复失败。');
    assert.ok(target);
    compose(target, ['up', '-d', '--wait', 'postgres', 'minio'], '恢复数据服务启动失败。');
    const after = probe(target, 'inspect');
    assert.deepEqual(after, before, '恢复端的表行数或文件 SHA-256 不一致。');
    console.log(JSON.stringify({
      tables: Object.keys(after.tableCounts).length,
      files: Object.keys(after.blobs).length,
      sourceWasStopped: true, damagedArchiveRejected: true, restoredToNewVolumes: true,
    }));
  } finally {
    if (target) compose(target, ['down'], '恢复演练容器停止失败。');
    compose(source, ['down'], '源演练容器停止失败。');
  }
}

let stage = '备份恢复演练失败。';
try {
  if (process.argv[2] === '--fixture' && ['seed', 'inspect'].includes(process.argv[3])) {
    stage = '合成备份探针失败。';
    await fixture(process.argv[3]);
  } else await drill();
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  console.error(message.length < 100 && /^[\p{Script=Han}][\p{Script=Han}。，、 A-Z0-9-]*$/u.test(message) ? message : stage);
  process.exitCode = 1;
}
