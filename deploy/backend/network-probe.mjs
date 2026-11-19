import { createServer, request } from 'node:http';
import { connect, isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { Resolver } from 'node:dns/promises';

const [action, role, databaseIp] = process.argv.slice(2);
const probeEnvironment = new Set(['HOME', 'HOSTNAME', 'NODE_VERSION', 'PATH', 'YARN_VERSION']);

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(5000, () => finish(false));
    socket.on('error', () => finish(false));
    socket.on('connect', () => finish(true));
  });
}

function proxyStatus(proxy, hostname, verifyCertificate = false) {
  return new Promise((resolve) => {
    const target = `${hostname}:443`;
    const tunnel = request({
      hostname: proxy,
      port: 3128,
      method: 'CONNECT',
      path: target,
      headers: { Host: target },
    });
    tunnel.setTimeout(8000, () => tunnel.destroy());
    tunnel.on('error', () => resolve(null));
    tunnel.on('connect', (response, socket, head) => {
      if (response.statusCode !== 200 || !verifyCertificate) {
        socket.destroy();
        resolve(response.statusCode);
        return;
      }
      if (head.length) {
        socket.destroy();
        resolve(null);
        return;
      }
      const secured = tlsConnect({ socket, servername: hostname, rejectUnauthorized: true });
      secured.setTimeout(8000, () => secured.destroy());
      secured.on('close', () => resolve(null));
      secured.on('error', () => resolve(null));
      secured.on('secureConnect', () => {
        resolve(secured.authorized ? 200 : null);
        secured.destroy();
      });
    });
    tunnel.end();
  });
}

async function trustedTunnel(proxy, hostname) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const status = await proxyStatus(proxy, hostname, true);
    if (status !== null) return status === 200;
  }
  return false;
}

async function checkNetwork() {
  if (role !== 'backend' && !Object.keys(process.env).every((key) => probeEnvironment.has(key)))
    return { keysAbsent: false };
  const direct = canConnect('104.18.2.115', 443);
  const database = canConnect(databaseIp, 5432);
  const resolver = new Resolver({ timeout: 1500, tries: 1 });
  const directDns = resolver.resolve4('pypi.org').then(
    () => true,
    () => false,
  );
  const checks = { directBlocked: !(await direct), externalDnsBlocked: !(await directDns) };
  if (role === 'backend') {
    checks.databaseReachable = await database;
    checks.proxyAllowed = await trustedTunnel('egress', 'openrouter.ai');
    checks.proxyDenied = (await proxyStatus('egress', 'fixture.invalid')) === 403;
  } else {
    checks.databaseBlocked = !(await database);
    checks.internalRelayBlocked = !(await canConnect('probe-relay', 28082));
    checks.keysAbsent = true;
    if (role === 'sandbox') {
      checks.proxyAllowed = await trustedTunnel('sandbox-egress', 'pypi.org');
      checks.filesAllowed = await trustedTunnel('sandbox-egress', 'files.pythonhosted.org');
      checks.modelServiceBlocked = !(await canConnect('egress', 3128));
      checks.modelProxyDenied = (await proxyStatus('sandbox-egress', 'openrouter.ai')) === 403;
      checks.otherHostDenied = (await proxyStatus('sandbox-egress', 'fixture.invalid')) === 403;
    }
  }
  return checks;
}

if (action === 'listen' && ['doc', 'sandbox', 'fetch'].includes(role)) {
  createServer((request, response) => {
    if (request.url !== '/health') return response.writeHead(404).end();
    return response.writeHead(200, { 'content-type': 'text/plain' }).end(role);
  }).listen(8080, '0.0.0.0');
} else if (
  action === 'check' &&
  ['backend', 'sandbox', 'fetch'].includes(role) &&
  isIP(databaseIp)
) {
  const checks = await checkNetwork();
  console.log(JSON.stringify(checks));
  if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
} else process.exitCode = 2;
