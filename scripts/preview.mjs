import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { previewSlots } from '../packages/shared/src/config.ts';
import { previewIsIdle } from '../apps/backend/src/preview/idle.ts';
import { backendEnvironment } from './start-backend.mjs';
import { localProcessEnvironment, runDev } from './dev.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const previewEvidence = path.join(root, '.local', 'preview', 'walkthrough.json');
const baseEnvironment = () => localProcessEnvironment();
const slotKeys = ['lan', 'walkthrough'];

function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('无法核对预览代码版本。');
  return result.stdout.trim();
}

export function previewGitHead() {
  return git('rev-parse', 'HEAD');
}

export async function previewEnvironment(slotName, officialFetcher = false) {
  if (!slotKeys.includes(slotName)) throw new Error('请选择 lan 或 walkthrough。');
  const slot = previewSlots[slotName];
  const local = parseEnv(await readFile(path.join(root, '.env.local'), 'utf8'));
  if (!local.POSTGRES_PASSWORD) throw new Error('预览缺少本地数据库密码。');
  const database = new URL('postgresql://cert_board@127.0.0.1:25435/');
  database.password = local.POSTGRES_PASSWORD;
  database.pathname = '/' + slot.database;
  const test = new URL(database);
  test.pathname = database.pathname + '_test';
  const runtime = {
    ...local,
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: String(slot.apiPort),
    WEB_ORIGIN: `http://127.0.0.1:${slot.webPort}`,
    DATABASE_URL: database.href,
    TEST_DATABASE_URL: test.href,
    MINIO_BUCKET: slot.bucket,
    ...(slotName === 'walkthrough' && officialFetcher
      ? { CERT_FETCHER_URL: 'http://127.0.0.1:28084/' }
      : {}),
  };
  delete runtime.CERT_DEV_MODEL_ID;
  delete runtime.CERT_CURSOR_ACCEPTANCE_WORKER;
  if (slotName === 'walkthrough' && process.env.CERT_CURSOR_ACCEPTANCE === '1') {
    runtime.CERT_CURSOR_ACCEPTANCE_WORKER = '1';
    delete runtime.OPENROUTER_API_KEY;
  }
  const seed = {
    ...backendEnvironment('api', runtime),
    ...Object.fromEntries(
      [
        'DEV_ZHANGSAN_PASSWORD',
        'DEV_WANGMIN_PASSWORD',
        'DEV_ADMIN_PASSWORD',
        'CERT_DATA_DIR',
      ].flatMap((name) => (local[name] === undefined ? [] : [[name, local[name]]])),
    ),
  };
  return { slot, runtime, seed };
}

function launch(exe, args, cwd, env, logFile, ipc = false) {
  const stdio = logFile ? ['ignore', 'pipe', 'pipe', ipc ? 'ipc' : 'ignore'] : 'inherit';
  const child = spawn(exe, args, { cwd, env, stdio, windowsHide: true, shell: false });
  if (logFile) {
    const log = createWriteStream(logFile, { flags: 'a' });
    log.on('error', () => {
      console.error('预览日志写入失败，请检查本机目录。');
      child.kill('SIGTERM');
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.once('close', () => log.end());
  }
  const done = new Promise((resolve) => {
    child.once('error', () => resolve(1));
    child.once('close', (code) => resolve(code ?? 1));
  });
  return { child, done };
}

async function node(args, cwd, env) {
  const { done } = launch(process.execPath, args, cwd, env);
  if ((await done) !== 0) throw new Error('预览构建或初始化未完成，请检查本机输出。');
}

async function pnpm(args, cwd) {
  const entry = process.env.npm_execpath;
  if (!entry || !path.isAbsolute(entry)) throw new Error('请从仓库执行 pnpm 的预览命令。');
  await node([entry, ...args], cwd, baseEnvironment());
}

async function acceptedVersion() {
  const evidence = JSON.parse(await readFile(previewEvidence, 'utf8'));
  if (
    evidence.status !== 'passed' ||
    typeof evidence.commit !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(evidence.commit) ||
    typeof evidence.evidence !== 'string'
  )
    throw new Error('稳定预览需要通过真实走查的提交。');
  const evidenceDirectory = await realpath(path.join(root, '.local', 'preview', 'evidence'));
  const recorded = await realpath(evidence.evidence);
  if (path.dirname(recorded) !== evidenceDirectory) throw new Error('稳定预览证据位置不正确。');
  const proof = JSON.parse(await readFile(path.join(recorded, 'result.json'), 'utf8'));
  if (
    proof.status !== 'passed' ||
    proof.commit !== evidence.commit ||
    typeof proof.instance !== 'string' ||
    !proof.errorId ||
    !proof.registration?.url ||
    !proof.maintenance?.url ||
    !proof.verification?.channels?.some((item) => item.channel === 'gateway') ||
    !proof.verification?.channels?.some((item) => item.channel === 'cursor')
  )
    throw new Error('稳定预览缺少完整的真实走查记录。');
  return evidence.commit;
}

async function acceptedRoot(commit) {
  if (git('rev-parse', `${commit}^{commit}`) !== commit) throw new Error('无法核对已验收提交。');
  const releases = path.join(root, '.local', 'preview', 'releases');
  await mkdir(releases, { recursive: true });
  const source = path.join(releases, commit);
  if (
    !(await stat(path.join(source, 'package.json')).then(
      () => true,
      () => false,
    ))
  ) {
    git('worktree', 'add', '--detach', source, commit);
  }
  const actual = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: source,
    encoding: 'utf8',
    windowsHide: true,
  });
  const working = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: source,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (actual.stdout?.trim() !== commit || working.status !== 0 || working.stdout?.trim())
    throw new Error('稳定预览工作树已改变，请保留旧环境。');
  await pnpm(['install', '--offline', '--frozen-lockfile'], source);
  await pnpm(['build'], source);
  return source;
}

async function waitForReady(port, route, instance, serviceExited) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (serviceExited()) break;
    try {
      const result = await fetch(`http://127.0.0.1:${port}${route}`, {
        signal: AbortSignal.timeout(1500),
      });
      if (result.ok && result.headers.get('x-cert-preview-instance') === instance) return;
    } catch {
      /* 回环服务启动中 */
    }
    await wait(500);
  }
  throw new Error('预览服务未就绪，请检查独立端口、数据库与日志。');
}

export async function startPreview(slotName, preparedSource, officialFetcher = false) {
  const { slot, runtime, seed } = await previewEnvironment(slotName, officialFetcher);
  const source = preparedSource ?? root;
  if (slotName === 'lan' && !preparedSource) throw new Error('稳定预览缺少已验收版本。');
  const logDirectory = path.join(root, '.local', 'preview', slotName);
  await mkdir(logDirectory, { recursive: true });
  if ((await runDev('preview-up', root)) !== 0) throw new Error('预览数据库未能启动。');
  await node(['--import', 'tsx', 'apps/backend/src/db/cli.ts', 'setup'], source, seed);
  await node(['--import', 'tsx', 'apps/backend/src/preview/seed.ts'], source, seed);
  if (slotName !== 'lan') await pnpm(['build'], source);
  const services = [];
  const instance = randomUUID();
  let exited = false;
  const stop = async () => {
    for (const service of services)
      if (service.child.exitCode === null) service.child.kill('SIGTERM');
    await Promise.allSettled(services.map(({ done }) => done));
  };
  try {
    const backendEntries = {
      api: 'server.ts',
      worker: 'worker.ts',
      verification: 'verification-worker.ts',
    };
    for (const kind of ['api', 'worker', 'verification'])
      services.push(
        launch(
          process.execPath,
          ['--import', 'tsx', `apps/backend/src/${backendEntries[kind]}`],
          source,
          {
            ...backendEnvironment(kind, runtime),
            ...(kind === 'api' ? { CERT_PREVIEW_INSTANCE: instance } : {}),
          },
          path.join(logDirectory, `${kind}.log`),
          kind === 'api' && slotName === 'lan',
        ),
      );
    for (const service of services)
      void service.done.then(() => {
        exited = true;
      });
    await waitForReady(slot.apiPort, '/health', instance, () => exited);
    const web = path.join(source, 'apps', 'web');
    services.push(
      launch(
        process.execPath,
        [
          path.join(web, 'node_modules', 'vite', 'bin', 'vite.js'),
          'preview',
          '--config',
          'vite.preview.config.ts',
          '--host',
          '127.0.0.1',
          '--port',
          String(slot.webPort),
          '--strictPort',
        ],
        web,
        {
          ...baseEnvironment(),
          CERT_PREVIEW_API_PORT: String(slot.apiPort),
          CERT_PREVIEW_INSTANCE: instance,
        },
        path.join(logDirectory, 'web.log'),
      ),
    );
    void services.at(-1).done.then(() => {
      exited = true;
    });
    await waitForReady(slot.webPort, '/', instance, () => exited);
    console.log(
      `预览地址 ${runtime.WEB_ORIGIN}，账号 zhangsan，密码使用 .env.local 的 DEV_ZHANGSAN_PASSWORD。`,
    );
    return {
      stop,
      done: Promise.race(services.map(({ done }) => done)),
      api: services[0].child,
      instance,
      exited: () => exited,
      runtime,
      source,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

function drain(api) {
  return new Promise((resolve) => {
    const finish = (idle) => {
      clearTimeout(timeout);
      api.off('message', acknowledge);
      resolve(idle);
    };
    const acknowledge = (message) => {
      if (message?.type === 'preview-drain') finish(message.pending === 0);
    };
    const timeout = setTimeout(() => finish(false), 1500);
    api.on('message', acknowledge);
    api.send('preview-drain', (error) => {
      if (error) finish(false);
    });
  });
}

async function servePreview(slotName) {
  let version = slotName === 'lan' ? await acceptedVersion() : undefined;
  let live = await startPreview(slotName, version ? await acceptedRoot(version) : undefined);
  let stopping = false;
  const stop = () => {
    stopping = true;
    void live.stop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let prepared;
  try {
    if (slotName !== 'lan') return await live.done;
    while (!stopping) {
      const result = await Promise.race([live.done, wait(10_000, 'poll')]);
      if (result !== 'poll' || stopping) return result === 'poll' ? 0 : result;
      let nextVersion;
      try {
        nextVersion = await acceptedVersion();
        if (nextVersion === version) continue;
        if (prepared?.version !== nextVersion)
          prepared = { version: nextVersion, source: await acceptedRoot(nextVersion) };
        if (stopping || !(await previewIsIdle(live.runtime.DATABASE_URL))) continue;
        if (!(await drain(live.api)) || !(await previewIsIdle(live.runtime.DATABASE_URL))) {
          live.api.send('preview-resume', () => undefined);
          continue;
        }
      } catch {
        if (live.api.connected) live.api.send('preview-resume', () => undefined);
        console.error('预览升级准备未完成，当前版本继续运行。');
        await wait(20_000);
        continue;
      }
      const previousSource = live.source;
      await live.stop();
      if (stopping) return 0;
      try {
        live = await startPreview(slotName, prepared.source);
        version = nextVersion;
      } catch {
        console.error('预览升级未完成，恢复上一个版本。');
        if (stopping) return 0;
        live = await startPreview(slotName, previousSource);
        await wait(20_000);
      }
    }
    return 0;
  } finally {
    await live.stop();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await servePreview(process.argv[2]);
  } catch (error) {
    const message =
      error instanceof Error && /^(?:预览|本地|无法|稳定|请选择|请从)/u.test(error.message)
        ? error.message
        : '预览启动失败，请核对已验收提交、端口和依赖服务。';
    console.error(message);
    process.exitCode = 1;
  }
}
