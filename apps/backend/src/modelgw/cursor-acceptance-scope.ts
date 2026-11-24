import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const sha = z.string().regex(/^[a-f0-9]{40}$/u);
export const cursorAcceptancePrSchema = z.enum(['PR-34', 'PR-35']);
const approval = z.strictObject({ pr: cursorAcceptancePrSchema, head: sha });
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
  git: { testCommit: string; parents: string; tree: string; headSubject: string },
) {
  const { pr, head } = approval.parse(requested);
  const report = reportSchema.parse(rawReport);
  if (
    report.head !== head ||
    report.testCommit !== git.testCommit ||
    git.parents !== `${report.base} ${head}` ||
    report.mergeTree !== git.tree ||
    !git.headSubject.startsWith(`${pr} `)
  )
    throw new Error('CURSOR_ACCEPTANCE_SCOPE_REQUIRED');
  return { pr, head };
}

export async function confirmCursorAcceptanceScope(source: string, pr: unknown, head: unknown) {
  try {
    const requested = approval.parse({ pr, head });
    if (process.platform !== 'linux') throw new Error('CURSOR_ACCEPTANCE_VM_REQUIRED');
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
    return validateCursorAcceptanceScope(requested, rawReport, {
      testCommit: testCommit ?? '',
      parents: parents ?? '',
      tree: tree ?? '',
      headSubject: git('show', '-s', '--format=%s', requested.head),
    });
  } catch {
    throw new Error('CURSOR_ACCEPTANCE_SCOPE_REQUIRED');
  }
}
