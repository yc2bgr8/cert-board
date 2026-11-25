import { z } from 'zod';

const code = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/u);
const quote = z.string().min(1).max(500);
const source = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('document'),
    document: z.string().min(1).max(70),
    page: z.number().int().positive(),
    quote,
  }),
  z.strictObject({
    kind: z.literal('official'),
    url: z.url(),
    field: z.string().min(1).max(80),
    quote,
  }),
]);
const actual = z.strictObject({ code, state: z.literal('actual'), date: z.iso.date(), source });
const missing = z.strictObject({
  code,
  state: z.literal('missing_evidence'),
  date: z.null(),
  source: z.null(),
});
const rows = z.discriminatedUnion('state', [actual, missing]).array().max(30);
type Actual = z.infer<typeof actual>;

export function assessR01Timeline(
  input: unknown,
  expected: readonly Actual[],
  missingCodes: readonly string[],
) {
  const parsed = rows.safeParse(input);
  if (!parsed.success) return ['invalid_timeline'];
  const reported = new Map(parsed.data.map((row) => [row.code, row]));
  const issues: string[] = [];
  if (reported.size !== parsed.data.length) issues.push('duplicate_node');
  for (const item of expected) {
    const row = reported.get(item.code);
    if (
      !row ||
      row.state !== 'actual' ||
      row.date !== item.date ||
      !sameSource(row.source, item.source)
    )
      issues.push(`wrong_date_or_source:${item.code}`);
  }
  for (const code of missingCodes) {
    if (reported.get(code)?.state !== 'missing_evidence') issues.push(`unconfirmed_date:${code}`);
  }
  return issues;
}

function sameSource(left: Actual['source'], right: Actual['source']) {
  if (left.quote !== right.quote) return false;
  if (left.kind === 'document' && right.kind === 'document')
    return left.document === right.document && left.page === right.page;
  if (left.kind === 'official' && right.kind === 'official')
    return left.url === right.url && left.field === right.field;
  return false;
}
