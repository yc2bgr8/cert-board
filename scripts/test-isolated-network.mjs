import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { chromium } from 'playwright-core';
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

async function verifyBrowser(url) {
  let browser;
  let stage = '开发账号';
  try {
    assert.equal(await runDev('isolated-accounts'), 0);
    const { DEV_ADMIN_PASSWORD: password } = parseEnv(
      await readFile(new URL('../.env.local', import.meta.url), 'utf8'),
    );
    assert.ok(password);
    stage = '浏览器登录';
    browser = await chromium
      .launch({ channel: 'chrome', headless: true })
      .catch(() => chromium.launch({ channel: 'msedge', headless: true }));
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === url ? route.continue() : route.abort(),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(url);
    await page.getByRole('textbox', { name: '账号', exact: true }).fill('admin');
    await page.getByLabel('密码', { exact: true }).fill(password);
    const loggedIn = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/auth/login' &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const session = await loggedIn;
    assert.equal(session.status(), 200);
    const { csrfToken } = await session.json();
    assert.equal(typeof csrfToken, 'string');
    stage = '会话写入和 Cursor 门禁';
    const proof = await page.evaluate(async (csrf) => {
      const list = async () => (await (await fetch('/api/verification/rooms')).json()).items.length;
      const before = await list();
      const verification = await fetch('/api/verification/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({
          requestKey: globalThis.crypto.randomUUID(),
          question: '隔离试验不派发',
        }),
      });
      return {
        verification: verification.status,
        unchanged: before === (await list()),
      };
    }, csrfToken);
    assert.deepEqual(proof, { verification: 503, unchanged: true });
    await page.getByRole('button', { name: '外部模型', exact: true }).click();
    await page
      .getByText('容器工作台尚未接入 Cursor 核实。请在 Windows 日常工作台发起核实。', {
        exact: true,
      })
      .waitFor();
    await page.getByRole('textbox', { name: '核实问题', exact: true }).fill('隔离验收');
    assert.equal(
      await page.getByRole('button', { name: '发起核实', exact: true }).isDisabled(),
      true,
    );
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByRole('region', { name: '外部模型设置', exact: true });
    const save = settings.getByRole('button', { name: '保存外部模型设置', exact: true });
    await save.waitFor();
    assert.equal(await save.isDisabled(), true);
    stage = '浏览器注销写入';
    const loggedOut = await page.evaluate(async (csrf) => {
      const missing = await fetch('/api/auth/logout', { method: 'POST' });
      const revoke = await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'x-csrf-token': csrf },
      });
      const authentication = await fetch('/api/auth/me');
      return {
        missing: missing.status,
        revoke: revoke.status,
        authentication: authentication.status,
      };
    }, csrfToken);
    assert.deepEqual(loggedOut, { missing: 403, revoke: 204, authentication: 401 });
  } catch {
    throw new Error(`隔离浏览器验收未通过 ${stage}`);
  } finally {
    await browser?.close();
  }
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
  await verifyBrowser(url);
  console.log('浏览器登录、注销会话与隔离模式的 Cursor 门禁已验证。');
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
  for (const field of ['DATABASE_URL', 'TEST_DATABASE_URL', 'CERT_DB_PASSWORD_URI']) {
    const injected = dockerProcess(
      'exec',
      '-e',
      `${field}=synthetic`,
      container('sandbox-probe'),
      'node',
      'deploy/backend/network-probe.mjs',
      'check',
      'sandbox',
      databaseIp,
    );
    assert.equal(injected.status, 1, `沙箱未拦截合成连接配置 ${field}`);
    assert.deepEqual(JSON.parse(injected.stdout), { keysAbsent: false });
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
