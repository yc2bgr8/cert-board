import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { proxyProbe, egressProbeMarker } from './verify-egress.mjs';
import { verifyEgressLogs } from './verify-egress-container.mjs';

test('容器日志同时检查stdout和stderr，敏感标记不能躲入stderr', () => {
  const stdout =
    '1794963196.008 CONNECT openrouter.ai 443 200 TCP_TUNNEL\n1794963197.008 CONNECT example.com 443 403 TCP_DENIED\n';
  expect(verifyEgressLogs({ stdout, stderr: '' })).toBe(2);
  expect(() => verifyEgressLogs({ stdout, stderr: `${egressProbeMarker}\n` })).toThrow(
    '日志验证未通过',
  );
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
