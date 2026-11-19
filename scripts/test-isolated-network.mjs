import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { localProcessEnvironment, runDev } from './dev.mjs';

const project = 'cert-board-isolated';
const container = (service) => `${project}-${service}-1`;
const network = (name) => `${project}_${name}`;
const developmentPorts = { doc: 28187, sandbox: 28188, fetch: 28189 };

function dockerProcess(...args) {
  const onWindows = process.platform === 'win32';
  return spawnSync(
    onWindows ? 'wsl.exe' : 'docker',
    [
      ...(onWindows ? ['-d', 'Ubuntu-24.04', '--exec', 'docker'] : []),
      '--context',
      'default',
      ...args,
    ],
    { encoding: 'utf8', timeout: 50000, windowsHide: true, env: localProcessEnvironment() },
  );
}

function docker(...args) {
  const result = dockerProcess(...args);
  const stdout = result.stdout?.trim() ?? '';
  if (result.status !== 0) {
    if (args[0] === 'exec' && stdout.startsWith('{'))
      console.error(`网络探针未通过 ${args[1]} ${stdout}`);
    throw new Error(`网络验收中的 Docker 操作未成功 ${args[0]} ${args[1] ?? ''}`);
  }
  return stdout;
}

function connectedNetworks(service) {
  const details = JSON.parse(
    docker('inspect', '--format', '{{json .NetworkSettings.Networks}}', container(service)),
  );
  return Object.keys(details).sort();
}

async function workbenchReady(url) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(4000) }).catch(
      () => null,
    );
    if (response?.ok) return;
    await delay(500);
  }
  throw new Error('隔离工作台尚未通过回环入口健康检查');
}

async function main() {
  const port = Number(process.env.CERT_ISOLATED_WEB_PORT ?? '28080');
  assert.ok([28080, 28186].includes(port), '请使用容器工作台的固定回环端口');
  const url = `http://127.0.0.1:${port}`;
  await workbenchReady(url);
  const index = await fetch(`${url}/`, { signal: AbortSignal.timeout(5000) });
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/u);
  assert.match(await index.text(), /\/assets\//u);
  assert.equal(await runDev('isolated-check'), 0);

  for (const service of ['backend-api', 'backend-worker']) {
    assert.deepEqual(connectedNetworks(service), [network('internal')]);
  }
  for (const service of [
    'backend-api',
    'backend-worker',
    'postgres',
    'minio',
    'egress',
    'sandbox-egress',
  ])
    assert.equal(docker('port', container(service)), '');
  assert.equal(docker('port', container('web'), '8080/tcp'), `127.0.0.1:${port}`);
  for (const [service, expected] of [
    ['doc-probe', 'internal'],
    ['sandbox-probe', 'sandbox'],
    ['fetch-probe', 'fetch'],
  ])
    assert.deepEqual(connectedNetworks(service), [network(expected)]);
  for (const isolated of ['internal', 'sandbox', 'fetch'])
    assert.equal(
      docker(
        'network',
        'inspect',
        '--format',
        '{{.Internal}}|{{index .Options "com.docker.network.bridge.gateway_mode_ipv4"}}',
        network(isolated),
      ),
      'true|isolated',
    );

  const databaseIp = docker(
    'inspect',
    '--format',
    `{{(index .NetworkSettings.Networks "${network('internal')}").IPAddress}}`,
    container('postgres'),
  );
  assert.ok(isIP(databaseIp), '未找到隔离数据库网卡');
  for (const [service, role] of [
    ['backend-api', 'backend'],
    ['backend-worker', 'backend'],
    ['sandbox-probe', 'sandbox'],
    ['fetch-probe', 'fetch'],
  ]) {
    const result = docker(
      'exec',
      container(service),
      'node',
      'deploy/backend/network-probe.mjs',
      'check',
      role,
      databaseIp,
    );
    console.log(`${service} ${result}`);
  }

  for (const [service, relayPort] of Object.entries(developmentPorts)) {
    const check = await fetch(`http://127.0.0.1:${relayPort}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(check.status, 200);
    assert.equal(await check.text(), service);
  }
  for (const service of ['web', 'probe-relay']) {
    docker('exec', container(service), 'nc', '-z', '-w', '3', 'backend-api', '28081');
    const direct = dockerProcess(
      'exec',
      container(service),
      'nc',
      '-n',
      '-z',
      '-w',
      '3',
      '104.18.2.115',
      '443',
    );
    assert.equal(direct.status, 1, `${service} 可直连公网或未完成隔离检查`);
  }
  const log = docker('logs', '--since', '5m', container('egress'));
  assert.match(log, /CONNECT[^\r\n]+openrouter\.ai/u);
  assert.match(log, /CONNECT[^\r\n]+fixture\.invalid/u);
  const workerLog = docker('logs', '--since', '2m', container('backend-worker'));
  assert.match(workerLog, /"event":"worker_(?:ready|heartbeat)"/u);
  console.log('隔离部署、代理白名单、跨网段阻断和开发中继已验证。');
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : '网络验收未通过');
  process.exitCode = 1;
});
