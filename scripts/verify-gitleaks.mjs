import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const branch = 'pr-00-gitleaks-probe';
const probe = path.resolve(root, '.local', 'gitleaks-probe');
if (!probe.startsWith(path.resolve(root, '.local') + path.sep)) throw new Error('探针路径越界');
mkdirSync(path.dirname(probe), { recursive: true });
const git = (args, cwd = root) => execFileSync('git', args, { cwd, stdio: 'pipe' });
const mountPath = (filename) =>
  process.platform === 'win32'
    ? execFileSync('wsl', [
        '-d',
        'Ubuntu-24.04',
        '--exec',
        'wslpath',
        '-a',
        filename.replaceAll('\\', '/'),
      ])
        .toString()
        .trim()
    : filename;
let created = false;
try {
  git(['worktree', 'add', '-b', branch, probe, 'HEAD']);
  created = true;
  // 合成不可用令牌，仅验证扫描器；从不推送此临时分支。
  writeFileSync(
    path.join(probe, 'fake-token.txt'),
    `token=ghp_${randomBytes(18).toString('hex')}\n`,
  );
  git(['add', 'fake-token.txt'], probe);
  git(['commit', '-m', '临时测试：验证密钥拦截'], probe);
  const args = [
    'run',
    '--rm',
    '-v',
    `${mountPath(root)}:/repo:ro`,
    'zricethezav/gitleaks:v8.24.3',
    'git',
    '/repo',
    '--redact',
    '--no-banner',
    `--log-opts=${branch} -1`,
  ];
  const result =
    process.platform === 'win32'
      ? spawnSync('wsl', ['-d', 'Ubuntu-24.04', '--', 'docker', ...args], { encoding: 'utf8' })
      : spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 1 || !/leaks found/i.test(result.stderr + result.stdout)) {
    throw new Error(`密钥拦截探针未获得预期拒绝，退出码：${result.status}`);
  }
  console.log('gitleaks 成功拦截临时分支中的合成密钥（退出码1）。');
} finally {
  if (created) {
    git(['worktree', 'remove', '--force', probe]);
    git(['branch', '-D', branch]);
  }
}
