import { z } from 'zod';
import { documentCitationSchema } from '@cert-board/shared';

const category = z.string().regex(/^[a-z][a-z0-9_]{1,49}$/u);
const statement = z.string().trim().min(1).max(600);
const coordinate = documentCitationSchema.omit({ quote: true });
export const r04ScenarioSchema = z.strictObject({
  id: z.string().min(1).max(80),
  synthetic: z.literal(true),
  asOf: z.iso.date(),
  market: z.literal('美国'),
  request: statement,
  pages: coordinate
    .extend({ availableOn: z.iso.date(), text: z.string().min(1).max(12000) })
    .array()
    .min(1)
    .max(12),
});

const officialBasis = z.strictObject({
  title: statement,
  edition: statement,
  url: z.url().refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      ['www.fda.gov', 'www.accessdata.fda.gov'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port
    );
  }),
});
const row = z.strictObject({
  category,
  productSource: documentCitationSchema,
  basis: officialBasis,
  status: z.enum(['existing', 'missing', 'outdated', 'uncertain', 'not_applicable']),
  scope: z.enum(['not_yet_tested', 'tested_only', 'extension_pending', 'justified']),
  testedModels: statement.array().max(8),
  targetModels: statement.array().min(1).max(8),
  sampleSource: documentCitationSchema.nullable(),
  representativeBasis: documentCitationSchema.nullable(),
  criterion: documentCitationSchema.nullable(),
  result: z.enum(['pending', 'met']),
});
const plan = row.array().min(1).max(32);
type Scenario = z.infer<typeof r04ScenarioSchema>;
type PlanRow = z.infer<typeof row>;
type ExpectedRow = {
  category: string;
  status?: PlanRow['status'];
  scope?: PlanRow['scope'];
  productQuote?: string;
  testedModels?: readonly string[];
};
export type R04Issue = { category: string; code: string };

function location(ref: Pick<z.infer<typeof coordinate>, 'documentId' | 'version' | 'page'>) {
  return `${ref.documentId.toLowerCase()}:${ref.version}:${ref.page}`;
}

export function assessR04Plan(
  input: unknown,
  scenario: Scenario,
  expected: readonly ExpectedRow[],
): R04Issue[] {
  const parsed = plan.safeParse(input);
  if (!parsed.success) return [{ category: '*', code: 'invalid_plan' }];
  const issues: R04Issue[] = [];
  const pages = new Map(
    scenario.pages
      .filter((page) => page.availableOn <= scenario.asOf)
      .map((page) => [location(page), page.text]),
  );
  const verifies = (ref: z.infer<typeof documentCitationSchema>) =>
    pages.get(location(ref))?.includes(ref.quote) === true;
  const byCategory = new Map<string, PlanRow>();
  for (const entry of parsed.data) {
    const {
      category,
      productSource,
      sampleSource,
      representativeBasis,
      criterion,
      testedModels,
      targetModels,
    } = entry;
    const add = (code: string) => issues.push({ category, code });
    if (byCategory.has(category)) add('duplicate_category');
    byCategory.set(category, entry);
    if (
      ![productSource, sampleSource, representativeBasis, criterion].every(
        (ref) => ref === null || verifies(ref),
      )
    )
      add('unverifiable_quote');
    if (testedModels.some((model) => !sampleSource?.quote.includes(model)))
      add('unverifiable_sample');
    const extendsSample = targetModels.some((model) => !testedModels.includes(model));
    if (
      (entry.scope === 'justified' &&
        (testedModels.length === 0 || (extendsSample && !representativeBasis))) ||
      (entry.scope === 'tested_only' && (testedModels.length === 0 || extendsSample)) ||
      (entry.scope === 'not_yet_tested' && testedModels.length > 0) ||
      (entry.scope === 'extension_pending' && (testedModels.length === 0 || !extendsSample))
    )
      add('unsupported_scope');
    if (
      entry.result === 'met' &&
      (entry.status !== 'existing' ||
        !criterion ||
        !['tested_only', 'justified'].includes(entry.scope))
    )
      add('unsubstantiated_result');
  }
  for (const expectation of expected) {
    const row = byCategory.get(expectation.category);
    if (!row) issues.push({ category: expectation.category, code: 'missing_category' });
    else if (
      (expectation.status && expectation.status !== row.status) ||
      (expectation.scope && expectation.scope !== row.scope) ||
      (expectation.productQuote && expectation.productQuote !== row.productSource.quote) ||
      (expectation.testedModels &&
        (expectation.testedModels.length !== row.testedModels.length ||
          expectation.testedModels.some((model) => !row.testedModels.includes(model))))
    )
      issues.push({ category: expectation.category, code: 'unexpected_assessment' });
  }
  return issues;
}
