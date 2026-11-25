import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { proxyProbe, egressProbeMarker } from './verify-egress.mjs';
import { verifyEgressLogs } from './verify-egress-container.mjs';

const developmentPolicy = {
  allowedHosts: ['openrouter.ai'],
  openedHosts: ['openrouter.ai'],
  refusedHosts: ['fixture.invalid'],
};

test('容器日志同时检查stdout和stderr，敏感标记不能躲入stderr', () => {
  const stdout =
    '1794963196.008 CONNECT openrouter.ai 443 200 TCP_TUNNEL\n1794963197.008 CONNECT fixture.invalid 443 403 TCP_DENIED\n';
  expect(verifyEgressLogs({ stdout, stderr: '' }, developmentPolicy)).toBe(2);
  expect(() =>
    verifyEgressLogs({ stdout, stderr: `${egressProbeMarker}\n` }, developmentPolicy),
  ).toThrow('日志验证未通过');
});

test.each([
  'CONNECT fixture.invalid 443 200 TCP_TUNNEL',
  'CONNECT fixture.invalid 443 503 TCP_MISS',
  'CONNECT openrouter.ai 8443 200 TCP_TUNNEL',
  'POST openrouter.ai 443 200 TCP_MISS',
])('发现额外的未授权派发记录即失败（%s）', (entry) => {
  const stdout = [
    '1794963196.008 CONNECT openrouter.ai 443 200 TCP_TUNNEL',
    '1794963197.008 CONNECT fixture.invalid 443 403 TCP_DENIED',
  ].join('\n');
  expect(() =>
    verifyEgressLogs({ stdout, stderr: `1794963198.008 ${entry}` }, developmentPolicy),
  ).toThrow('日志验证未通过');
});

test('沙箱代理使用自己的白名单，并同时证明允许与拒绝的探针', () => {
  const policy = {
    allowedHosts: ['pypi.org', 'files.pythonhosted.org'],
    openedHosts: ['pypi.org', 'files.pythonhosted.org'],
    refusedHosts: ['fixture.invalid', 'openrouter.ai'],
  };
  const lines = [
    '1794963196.008 CONNECT pypi.org 443 200 TCP_TUNNEL',
    '1794963197.008 CONNECT files.pythonhosted.org 443 200 TCP_TUNNEL',
    '1794963198.008 CONNECT fixture.invalid 443 403 TCP_DENIED',
    '1794963199.008 CONNECT openrouter.ai 443 403 TCP_DENIED',
  ];
  const logs = { stdout: lines.slice(0, 3).join('\n'), stderr: lines[3] };
  expect(verifyEgressLogs(logs, policy)).toBe(4);
  expect(() => verifyEgressLogs({ ...logs, stderr: '' }, policy)).toThrow('日志验证未通过');
  expect(() =>
    verifyEgressLogs({ ...logs, stderr: lines[3].replace('403 TCP_DENIED', '200 TCP_TUNNEL') }, policy),
  ).toThrow('日志验证未通过');
});

test('最小代理仅登记既定精确OpenRouter主机，拒绝非CONNECT、非443和非白名单', async () => {
  const list = await readFile(new URL('../deploy/egress/allowlist', import.meta.url), 'utf8');
  expect(
    list
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  ).toEqual(['openrouter.ai']);
  const config = await readFile(new URL('../deploy/egress/squid.conf', import.meta.url), 'utf8');
  expect(config).toContain('acl allowed_domains dstdomain -n "/etc/squid/allowlist"');
  expect(config).toContain('acl secure_ports port 443');
  expect(config).toContain('acl tunnel_method method CONNECT');
  expect(config).toContain('198.18.0.0/15');
  expect(config).toContain('hosts_file /etc/squid/hosts');
  expect(config.match(/^http_access .+$/gm)).toEqual([
    'http_access deny !tunnel_method',
    'http_access deny !secure_ports',
    'http_access deny !allowed_domains',
    'http_access deny private_destinations',
    'http_access allow allowed_domains',
    'http_access deny all',
  ]);
  const format = config.split('\n').find((line) => line.startsWith('logformat '));
  expect(format).toBe('logformat cert_gateway %ts.%03tu %rm %>rd %>rP %>Hs %Ss');
  expect(config).not.toMatch(/ssl_bump|log_mime_hdrs on|auth_param/);
  const hosts = await readFile(new URL('../deploy/egress/hosts', import.meta.url), 'utf8');
  expect(
    hosts
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  ).toEqual(['104.18.2.115 openrouter.ai', '104.18.3.115 openrouter.ai']);
});

test('代理独立网络和回环端口不改变数据库的内部网络', async () => {
  const compose = await readFile(new URL('../deploy/compose.dev.yml', import.meta.url), 'utf8');
  const egress = compose.split('  egress:')[1].split('\nnetworks:')[0];
  expect(egress).toContain('networks: [egress]');
  expect(egress).toContain("'127.0.0.1:28085:3128'");
  expect(egress).toContain('read_only: true');
  expect(egress).toContain('cap_drop: [ALL]');
  expect(egress).not.toContain('environment:');
  expect(egress).not.toContain('volumes:');
  expect(compose.split('  postgres:')[1].split('  minio:')[0]).toContain('networks: [internal]');
  expect(compose.split('  minio:')[1].split('  relay:')[0]).toContain('networks: [internal]');
  const dockerfile = await readFile(
    new URL('../deploy/egress/Dockerfile', import.meta.url),
    'utf8',
  );
  expect(dockerfile).toContain('ARG SQUID_VERSION=6.14-0ubuntu0.24.04.5');
  expect(dockerfile).toContain('USER proxy');
  expect(dockerfile).toMatch(/FROM ubuntu:24\.04@sha256:[a-f0-9]{64}/);
});

test('官方数据的 DNS 映射仅在公开抓取代理生效，保留私网拒绝并只用已批准域名', async () => {
  const files = await Promise.all(
    ['Dockerfile', 'fetch-hosts', 'isolated-allowlist', 'fetch.conf'].map((name) =>
      readFile(new URL(`../deploy/egress/${name}`, import.meta.url), 'utf8'),
    ),
  );
  const [docker, hosts, allowlist, config] = files;
  const listed = (value) => value.split(/\r?\n/u).filter((line) => line && !line.startsWith('#'));
  const destinations = listed(hosts).map((row) => row.split(/\s+/u)[1]);
  expect(destinations.every((host) => listed(allowlist).includes(host))).toBe(true);
  expect(new Set(destinations)).toEqual(new Set([
    'openrouter.ai', 'api.fda.gov', 'health-products.canada.ca', 'accessgudid.nlm.nih.gov',
  ]));
  expect(docker).toMatch(/AS web-fetch\s+COPY fetch\.conf[^\n]*\s+COPY fetch-hosts \/etc\/squid\/hosts/u);
  expect(config).toContain('198.18.0.0/15');
  expect(config.indexOf('http_access deny private_destinations')).toBeLessThan(
    config.indexOf('http_access allow tunnel_method'),
  );
});

test('代理探针只连接本机、识别CONNECT响应并拒绝报文注入', async () => {
  let observed;
  const server = http.createServer();
  server.on('connect', (request, socket) => {
    observed = { method: request.method, url: request.url, remote: socket.remoteAddress };
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    expect(await proxyProbe('example.com:443', { port: server.address().port })).toBe(403);
    expect(observed).toEqual({ method: 'CONNECT', url: 'example.com:443', remote: '127.0.0.1' });
    expect(() => proxyProbe('target\r\nInjected: value')).toThrow('格式无效');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('代理构建保留固定镜像源和版本，虚拟机先启动依赖再做集成验收', async () => {
  const dockerfile = await readFile(
    new URL('../deploy/egress/Dockerfile', import.meta.url),
    'utf8',
  );
  const harness = await readFile(new URL('./acceptance-vm.mjs', import.meta.url), 'utf8');
  expect(dockerfile).toContain('/etc/apt/sources.list.d/ubuntu.sources');
  expect(dockerfile.indexOf('/etc/apt/sources.list.d/ubuntu.sources')).toBeLessThan(
    dockerfile.indexOf('apt-get -o Acquire::Retries=5 update'),
  );
  expect(dockerfile).toContain('//archive\\.ubuntu\\.com/ubuntu|//azure.archive.ubuntu.com/ubuntu');
  expect(dockerfile).toContain(
    '//security\\.ubuntu\\.com/ubuntu|//azure.archive.ubuntu.com/ubuntu',
  );
  expect(dockerfile).toContain('apt-get -o Acquire::Retries=5 install');
  expect(dockerfile).toContain('squid=${SQUID_VERSION} squid-common=${SQUID_VERSION}');
  expect(dockerfile).not.toMatch(
    /Verify-(?:Peer|Host)\s*=\s*(?:false|0)|allow-unauthenticated|trusted=yes/iu,
  );
  expect(harness).toMatch(
    /await pnpm\('dev-up', 'dev:up'\)[\s\S]*await pnpm\('integration', 'test:int'\)[\s\S]*await pnpm\('dev-down', 'dev:down'\)/u,
  );
});
