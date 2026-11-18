import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { egressProbeMarker } from './verify-egress.mjs';

const execute = promisify(execFile);
const systemKeys = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'HOME',
  'LANG',
]);
async function docker(args, includeStderr = false) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => systemKeys.has(key.toUpperCase())),
  );
  const binary = process.platform === 'win32' ? 'wsl.exe' : 'docker';
  const command =
    process.platform === 'win32' ? ['-d', 'Ubuntu-24.04', '--exec', 'docker', ...args] : args;
  const result = await execute(binary, command, {
    env,
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return includeStderr ? result : result.stdout;
}
const assert = (condition) => {
  if (!condition) throw new Error('代理容器隔离或日志验证未通过，请核对部署配置。');
};
export function verifyEgressLogs({ stdout, stderr }) {
  const output = `${stdout}\n${stderr}`;
  assert(!output.includes(egressProbeMarker));
  assert(!/authorization:|bearer |private\?probe=/i.test(output));
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  assert(lines.some((line) => / CONNECT openrouter\.ai 443 200 TCP_TUNNEL$/.test(line)));
  assert(lines.some((line) => / 403 TCP_DENIED$/.test(line)));
  assert(lines.every((line) => /^\d+\.\d{3} (?:CONNECT|POST) \S+ \d+ \d{3} \S+$/.test(line)));
  return lines.length;
}
export async function verifyEgressContainer() {
  const name = 'cert-board-egress-1';
  const [container] = JSON.parse(await docker(['inspect', name]));
  assert(container.Config.Labels['com.docker.compose.project'] === 'cert-board');
  assert(container.Config.Labels['com.docker.compose.service'] === 'egress');
  assert(container.State.Health?.Status === 'healthy');
  assert(container.HostConfig.ReadonlyRootfs === true);
  assert(container.HostConfig.CapDrop?.includes('ALL'));
  assert(
    container.HostConfig.SecurityOpt?.some((option) => option.startsWith('no-new-privileges')),
  );
  assert(Object.keys(container.NetworkSettings.Networks).join(',') === 'cert-board_egress');
  assert(container.Config.Env.every((entry) => !/(?:KEY|TOKEN|SECRET|PASSWORD)=/i.test(entry)));
  assert(container.Mounts.every((mount) => mount.Type === 'tmpfs'));
  assert(
    JSON.stringify(container.HostConfig.PortBindings) ===
      JSON.stringify({
        '3128/tcp': [{ HostIp: '127.0.0.1', HostPort: '28085' }],
      }),
  );
  assert((await docker(['exec', name, 'id', '-u'])).trim() !== '0');
  const version = (
    await docker(['exec', name, 'dpkg-query', '--show', '--showformat=${Version}', 'squid'])
  ).trim();
  assert(version === '6.14-0ubuntu0.24.04.5');
  const output = await docker(['logs', '--tail', '1000', name], true);
  return {
    version,
    user: 'non-root',
    credentials: false,
    loggedRequests: verifyEgressLogs(output),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyEgressContainer();
    console.log(
      `代理容器验证通过：Squid ${result.version}，非root、只读、无凭据；${result.loggedRequests}条安全元数据日志。`,
    );
  } catch {
    console.error('代理容器验证失败；未输出容器环境或原始日志。请先运行代理策略验证。');
    process.exitCode = 1;
  }
}
