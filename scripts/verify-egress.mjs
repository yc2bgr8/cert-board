import http from 'node:http';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const egressProbeMarker = 'synthetic-egress-private-marker';

export function proxyProbe(target, { method = 'CONNECT', port = 28085, body = '' } = {}) {
  if (typeof target !== 'string' || /[\r\n\0]/.test(target))
    throw new Error('代理探针目标格式无效。');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('代理探针端口无效。');
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: target,
      agent: false,
      headers: {
        host: method === 'CONNECT' ? target : new URL(target).host,
        connection: 'close',
        authorization: `Bearer ${egressProbeMarker}`,
        'content-length': Buffer.byteLength(body),
      },
    });
    request.setTimeout(10000, () => request.destroy(new Error('proxy_probe_timeout')));
    request.once('connect', (response, socket) => {
      socket.destroy();
      resolve(response.statusCode);
    });
    request.once('response', (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.once('error', () => reject(new Error('代理探针连接失败，请检查本地出网服务。')));
    request.end(body);
  });
}

export function verifyPublicModelMetadata() {
  return new Promise((resolve, reject) => {
    let encrypted;
    let finished = false;
    let header = '';
    const request = http.request({
      hostname: '127.0.0.1',
      port: 28085,
      method: 'CONNECT',
      path: 'openrouter.ai:443',
      agent: false,
      headers: { host: 'openrouter.ai:443' },
    });
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      encrypted?.destroy();
      request.destroy();
      if (error) reject(new Error('代理内TLS或公开模型目录验证失败，不能使用该开发DNS记录。'));
      else resolve(result);
    };
    const timer = setTimeout(() => finish(true), 15000);
    request.once('error', () => finish(true));
    request.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        finish(true);
        return;
      }
      encrypted = tls.connect({ socket, servername: 'openrouter.ai', rejectUnauthorized: true });
      encrypted.once('error', () => finish(true));
      encrypted.once('secureConnect', () => {
        if (!encrypted.authorized) return finish(true);
        encrypted.write(
          'GET /api/v1/models HTTP/1.1\r\nHost: openrouter.ai\r\nAccept: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n',
        );
      });
      encrypted.on('data', (chunk) => {
        header += chunk.toString('latin1');
        const boundary = header.indexOf('\r\n\r\n');
        if (boundary < 0) {
          if (header.length > 16384) finish(true);
          return;
        }
        const responseHeader = header.slice(0, boundary);
        if (
          !/^HTTP\/1\.[01] 200 /.test(responseHeader) ||
          !/\r\ncontent-type:\s*application\/json(?:[;\s]|$)/i.test(responseHeader)
        )
          return finish(true);
        const certificate = encrypted.getPeerCertificate();
        finish(false, {
          status: 200,
          authorized: true,
          certificateFingerprint256: certificate.fingerprint256,
          certificateValidTo: certificate.valid_to,
        });
      });
      encrypted.once('end', () => {
        if (!finished) finish(true);
      });
    });
    request.end();
  });
}

export async function verifyEgressPolicy() {
  const accepted = await proxyProbe('openrouter.ai:443');
  if (accepted !== 200) throw new Error('OpenRouter HTTPS隧道未通过，不能以直连替代。');
  const denied = [
    'example.com:443',
    'api.openrouter.ai:443',
    'openrouter.ai.example.com:443',
    'openrouter.ai:80',
    'openrouter.ai:8443',
    '127.0.0.1:443',
    '10.0.0.1:443',
    '172.16.0.1:443',
    '192.168.0.1:443',
    '169.254.169.254:443',
    '[::1]:443',
    '1.1.1.1:443',
  ];
  for (const authority of denied) {
    if ((await proxyProbe(authority)) !== 403)
      throw new Error('出网代理未拒绝某项禁止目标，必须先修复策略。');
  }
  const forbiddenHttp = await proxyProbe(
    `http://openrouter.ai/private?probe=${egressProbeMarker}`,
    { method: 'POST', body: egressProbeMarker },
  );
  if (forbiddenHttp !== 403) throw new Error('出网代理没有拒绝非CONNECT请求，必须先修复策略。');
  const metadata = await verifyPublicModelMetadata();
  return { allowed: 1, denied: denied.length + 1, modelRequests: 0, metadata };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyEgressPolicy();
    console.log(
      `代理策略验证通过：允许${result.allowed}项，拒绝${result.denied}项；TLS与公开模型目录通过，未使用密钥，模型请求0次。`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : '代理策略验证失败。');
    process.exitCode = 1;
  }
}
