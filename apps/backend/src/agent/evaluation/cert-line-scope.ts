import { z } from 'zod';
import { AppError } from '../../api/errors.js';

const sha = z.string().regex(/^[0-9a-f]{40}$/u);
const reportSchema = z.object({
  status: z.literal('running'),
  scope: z.literal('business'),
  base: sha,
  head: sha,
  mergeTree: sha,
  testCommit: sha,
  steps: z.array(z.object({ name: z.string(), exitCode: z.literal(0) })).max(40),
});

export const certLineScopeRefused = () =>
  new AppError(403, 'CERT_LINE_VM_SCOPE', '认证线真实评测须在 PR-36 的独立验收虚拟机运行。');

export function parseCertLineReport(report: unknown) {
  const checked = reportSchema.safeParse(report);
  if (!checked.success) throw certLineScopeRefused();
  return checked.data;
}

export function validateCertLineScope(
  report: unknown,
  git: { commit: string; tree: string; parents: string; subject: string; status: string },
) {
  const { base, head, mergeTree, testCommit, steps } = parseCertLineReport(report);
  if (
    testCommit !== git.commit ||
    mergeTree !== git.tree ||
    git.parents !== `${base} ${head}` ||
    !/^PR-36(?:\s|[：:])/u.test(git.subject) ||
    git.status ||
    !['dev-up', 'browser'].every((check) => steps.some(({ name }) => name === check))
  )
    throw certLineScopeRefused();
  return { base, head, mergeTree, testCommit };
}
