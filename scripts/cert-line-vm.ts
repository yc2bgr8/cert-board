import { execFileSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  certLineScopeRefused as refused,
  parseCertLineReport,
  validateCertLineScope,
} from '../apps/backend/src/agent/evaluation/cert-line-scope.js';

const marker = '/etc/cert-board-acceptance-vm';

export function isCertLineAcceptanceJob(argv: string[], scope: { base: string; head: string }) {
  if (
    path.basename(argv[0] ?? '') !== 'node' ||
    path.basename(argv[1] ?? '') !== 'acceptance-vm.mjs'
  )
    return false;
  const options = argv.slice(2);
  const has = (name: string, value: string) =>
    options.some(
      (item, index) =>
        item === name + '=' + value || (item === name && options[index + 1] === value),
    );
  return (
    has('--base', scope.base) &&
    has('--head', scope.head) &&
    has('--acceptance', 'eval:cert-line:real')
  );
}

async function assertActiveAcceptance(scope: { base: string; head: string }) {
  let pid = process.ppid;
  for (let hop = 0; pid > 1 && hop < 32; hop++) {
    const [status, command] = await Promise.all([
      readFile(`/proc/${pid}/status`, 'utf8'),
      readFile(`/proc/${pid}/cmdline`, 'utf8'),
    ]).catch(() => {
      throw refused();
    });
    if (isCertLineAcceptanceJob(command.split('\0').filter(Boolean), scope)) return;
    pid = Number(/^PPid:\s*(\d+)$/mu.exec(status)?.[1] ?? 0);
  }
  throw refused();
}

export async function requireCertLineVm(databaseUrl: string) {
  try {
    const database = URL.parse(databaseUrl);
    if (
      process.platform !== 'linux' ||
      database?.protocol !== 'postgresql:' ||
      database.hostname !== '127.0.0.1' ||
      database.port !== '25432' ||
      database.pathname !== '/cert_board' ||
      database.search ||
      database.hash
    )
      throw refused();
    const info = await lstat(marker);
    if (
      !info.isFile() ||
      info.uid !== 0 ||
      info.mode & 0o022 ||
      (await readFile(marker, 'utf8')).trim() !== 'cert-board-acceptance'
    )
      throw refused();

    const directory = path.dirname(process.cwd());
    const report = parseCertLineReport(
      JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8')),
    );
    const git = (...args: string[]) =>
      execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const [commit = '', tree = '', parents = ''] = git(
      'show',
      '-s',
      '--format=%H%n%T%n%P',
      'HEAD',
    ).split('\n');
    const scope = validateCertLineScope(report, {
      commit,
      tree,
      parents,
      subject: git('show', '-s', '--format=%s', report.head),
      status: git('status', '--porcelain=v1', '--untracked-files=normal'),
    });
    const assertActive = () => assertActiveAcceptance(scope);
    await assertActive();
    return { ...scope, directory, assertActive };
  } catch {
    throw refused();
  }
}
