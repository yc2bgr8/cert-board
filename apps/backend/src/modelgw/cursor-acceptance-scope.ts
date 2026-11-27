import { execFileSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const sha = z.string().regex(/^[a-f0-9]{40}$/u);
export const cursorAcceptancePrSchema = z.enum(['PR-34', 'PR-35']);
export const cursorAcceptanceTargets = { 'PR-34': 65, 'PR-35': 66 } as const;
const authorizationFile = '/etc/cert-board-cursor-acceptance.json';
const approval = z.strictObject({ pr: cursorAcceptancePrSchema, head: sha });
const authorization = approval.extend({
  number: z.union([z.literal(65), z.literal(66)]),
  observedHead: sha,
  base: sha,
  mergeTree: sha,
});
const reportSchema = z.object({
  scope: z.literal('business'),
  status: z.enum(['running', 'failed']),
  testCommit: sha,
  head: sha,
  base: sha,
  mergeTree: sha,
});

export function validateCursorAcceptanceScope(
  requested: unknown,
  rawReport: unknown,
  rawAuthorization: unknown,
  git: {
    testCommit: string;
    parents: string;
    tree: string;
    headSubject: string;
    worktreeStatus: string;
  },
) {
  const { pr, head } = approval.parse(requested);
  const report = reportSchema.parse(rawReport);
  const permit = authorization.parse(rawAuthorization);
  if (
    permit.pr !== pr ||
    permit.number !== cursorAcceptanceTargets[pr] ||
    permit.head !== head ||
    permit.base !== report.base ||
    permit.mergeTree !== report.mergeTree ||
    report.head !== head ||
    report.testCommit !== git.testCommit ||
    git.parents !== `${report.base} ${head}` ||
    report.mergeTree !== git.tree ||
    git.worktreeStatus !== '' ||
    !git.headSubject.startsWith(`${pr} `)
  )
    throw new Error('CURSOR_ACCEPTANCE_SCOPE_REQUIRED');
  return { pr, head };
}

export async function confirmCursorAcceptanceScope(source: string, pr: unknown, head: unknown) {
  try {
    const requested = approval.parse({ pr, head });
    if (process.platform !== 'linux') throw new Error('CURSOR_ACCEPTANCE_VM_REQUIRED');
    const permission = await lstat(authorizationFile);
    if (!permission.isFile() || permission.uid !== 0 || (permission.mode & 0o022) !== 0)
      throw new Error('CURSOR_ACCEPTANCE_SCOPE_REQUIRED');
    const permit = authorization.parse(JSON.parse(await readFile(authorizationFile, 'utf8')));
    const rawReport: unknown = JSON.parse(
      await readFile(path.join(source, '..', 'report.json'), 'utf8'),
    );
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: source,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    const [testCommit, parents, tree] = git('show', '-s', '--format=%H%n%P%n%T', 'HEAD').split(
      '\n',
    );
    const validated = validateCursorAcceptanceScope(requested, rawReport, permit, {
      testCommit: testCommit ?? '',
      parents: parents ?? '',
      tree: tree ?? '',
      headSubject: git('show', '-s', '--format=%s', requested.head),
      worktreeStatus: git('status', '--porcelain=v1', '--untracked-files=normal'),
    });
    git('merge-base', '--is-ancestor', permit.observedHead, validated.head);
    return validated;
  } catch {
    throw new Error('CURSOR_ACCEPTANCE_SCOPE_REQUIRED');
  }
}
