import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u);
const oid = z.string().regex(/^[0-9a-f]{40}$/u);
const count = z.number().int().min(0).max(1_000_000);
const rate = z
  .strictObject({ matched: count, total: count })
  .refine((item) => item.matched <= item.total);
const times = z.number().finite().min(0).max(3_600_000).array().max(20_000);
const evidence = id
  .array()
  .min(1)
  .max(30)
  .refine((items) => new Set(items).size === items.length);
const observed = <T extends z.ZodType>(data: T) => z.strictObject({ evidence, data }).optional();
const m02Ids = [
  'decision',
  'listing',
  'establishment',
  'us_agent',
  'applicant_registration',
  'brands',
  'udi',
] as const;
const l08Cases = ['E01', 'E02', 'E03', 'E04', 'E23'] as const;
const safetyIds = [
  'sandbox',
  'business_authorization',
  'web_archive',
  'model_gateway',
  'egress_and_telemetry',
  'isolation_and_releases',
] as const;
const severe = z.enum([
  'fabrication',
  'mislabelled_unverified',
  'false_completion',
  'unauthorized_action',
  'missed_statutory_deadline',
]);
const checklist = z.record(id, z.enum(['pass', 'fail', 'pending']));
const scope = z.enum(['synthetic', 'offline-development']);
const evidenceIdentity = z.strictObject({ id, scope, head: oid, main: oid, tree: oid });

export const v1ObservationSchema = z
  .strictObject({
    scope,
    head: oid,
    main: oid,
    tree: oid,
    evidenceIndex: evidenceIdentity.array().max(500).optional(),
    observations: z.strictObject({
      r09Known: observed(rate),
      r09Injected: observed(rate),
      r09Verbatim: observed(rate),
      r09FalsePositives: observed(rate),
      m02Public: observed(
        z.partialRecord(
          z.enum(m02Ids),
          z.enum(['pending_confirmation', 'missing', 'claimed_confirmed']),
        ),
      ),
      m01Import: observed(z.strictObject({ rows: rate, staffSampleConfirmed: z.boolean() })),
      m01Reminders: observed(z.strictObject({ due: rate, deadlineTests: rate })),
      ledger: observed(
        z.strictObject({
          enabled: id
            .array()
            .min(1)
            .max(50)
            .refine((items) => new Set(items).size === items.length),
          matches: checklist,
          outOfScope: rate,
        }),
      ),
      s01Trace: observed(rate),
      s01FirstPass: observed(rate),
      l08Agreement: observed(
        z.partialRecord(z.enum(l08Cases), z.enum(['pass', 'fail', 'pending'])),
      ),
      cpapStaffAgreement: observed(rate),
      nonModelFailures: observed(rate),
      firstWorkMs: observed(times),
      uiActionMs: observed(times),
      safetyChecks: observed(
        z.partialRecord(z.enum(safetyIds), z.enum(['pass', 'fail', 'pending'])),
      ),
      severeReview: observed(severe.array().max(1000)),
      staffFeedback: observed(
        z.strictObject({ favorable: count, mixed: count, unfavorable: count }),
      ),
      staffWeeklyUse: observed(z.number().int().min(0).max(7).array().max(100)),
    }),
  })
  .superRefine((input, context) => {
    if (!input.evidenceIndex) return;
    const indexed = new Map(input.evidenceIndex.map((item) => [item.id, item]));
    if (indexed.size !== input.evidenceIndex.length) {
      context.addIssue({ code: 'custom', path: ['evidenceIndex'], message: '证据标识不能重复。' });
    }
    for (const [key, item] of Object.entries(input.observations)) {
      if (!item) continue;
      if (
        item.evidence.some((reference) => {
          const source = indexed.get(reference);
          return (
            !source ||
            source.scope !== input.scope ||
            source.head !== input.head ||
            source.main !== input.main ||
            source.tree !== input.tree
          );
        })
      )
        context.addIssue({
          code: 'custom',
          path: ['observations', key, 'evidence'],
          message: '已登记证据须匹配本次范围、候选提交、基线和合并树。',
        });
    }
  });

type Observations = z.infer<typeof v1ObservationSchema>['observations'];
type Metric = {
  code: string;
  status: 'pass' | 'fail' | 'pending' | 'baseline';
  value: number | null;
  total: number | null;
  unit: 'ratio' | 'count' | 'ms' | 'days';
  evidence: string[];
};
type Sample<T> = { data: T; evidence: string[] } | undefined;

function pending(code: string, unit: Metric['unit'], source?: { evidence: string[] }): Metric {
  return {
    code,
    unit,
    status: 'pending',
    value: null,
    total: null,
    evidence: source?.evidence ?? [],
  };
}

function ratioMetric(
  code: string,
  sample: Sample<z.infer<typeof rate>>,
  status: (ratio: number) => Metric['status'],
): Metric {
  if (!sample?.data.total) return pending(code, 'ratio', sample);
  const ratio = sample.data.matched / sample.data.total;
  return {
    code,
    unit: 'ratio',
    status: status(ratio),
    value: ratio,
    total: sample.data.total,
    evidence: sample.evidence,
  };
}

function completeCheck(
  code: string,
  sample: Sample<Record<string, string | undefined>>,
  required: readonly string[],
  expected: string,
): Metric {
  if (!sample) return pending(code, 'count');
  const matched = required.filter((key) => sample.data[key] === expected).length;
  const failed = required.some((key) =>
    ['fail', 'missing', 'claimed_confirmed'].includes(sample.data[key] ?? ''),
  );
  return {
    code,
    unit: 'count',
    status: failed ? 'fail' : matched === required.length ? 'pass' : 'pending',
    value: matched,
    total: required.length,
    evidence: sample.evidence,
  };
}

function duration(code: string, sample: Sample<number[]>, limit: number): Metric {
  if (!sample?.data.length) return pending(code, 'ms', sample);
  const sorted = sample.data.toSorted((a, b) => a - b);
  const value = sorted[Math.ceil(sorted.length * 0.9) - 1]!;
  return {
    code,
    unit: 'ms',
    status: value <= limit ? 'pass' : 'fail',
    value,
    total: sorted.length,
    evidence: sample.evidence,
  };
}

const all = (value: number) => (value === 1 ? ('pass' as const) : ('fail' as const));
const baseline = () => 'baseline' as const;

function businessMetrics(data: Observations): Metric[] {
  const known = data.r09Known;
  const imports = data.m01Import;
  const reminders = data.m01Reminders;
  const ledger = data.ledger;
  return [
    known?.data.total === 8
      ? {
          code: 'r09_known_count',
          status: known.data.matched >= 7 ? 'pass' : 'fail',
          value: known.data.matched,
          total: 8,
          unit: 'count',
          evidence: known.evidence,
        }
      : pending('r09_known_count', 'count', known),
    ratioMetric('r09_injected', data.r09Injected, all),
    ratioMetric('r09_verbatim', data.r09Verbatim, all),
    ratioMetric('r09_false_positive_baseline', data.r09FalsePositives, baseline),
    completeCheck('m02_public', data.m02Public, m02Ids, 'pending_confirmation'),
    ratioMetric(
      'm01_import',
      imports ? { data: imports.data.rows, evidence: imports.evidence } : undefined,
      (value) => (value !== 1 ? 'fail' : imports?.data.staffSampleConfirmed ? 'pass' : 'pending'),
    ),
    ratioMetric(
      'm01_reminders',
      reminders ? { data: reminders.data.due, evidence: reminders.evidence } : undefined,
      all,
    ),
    ratioMetric(
      'm01_deadline_tests',
      reminders ? { data: reminders.data.deadlineTests, evidence: reminders.evidence } : undefined,
      all,
    ),
    completeCheck(
      'ledger_templates',
      ledger ? { data: ledger.data.matches, evidence: ledger.evidence } : undefined,
      ledger ? [...new Set([...ledger.data.enabled, ...Object.keys(ledger.data.matches)])] : [],
      'pass',
    ),
    ratioMetric(
      'ledger_out_of_scope',
      ledger ? { data: ledger.data.outOfScope, evidence: ledger.evidence } : undefined,
      all,
    ),
    ratioMetric('s01_traced_facts', data.s01Trace, all),
    ratioMetric('s01_first_pass_baseline', data.s01FirstPass, baseline),
    completeCheck('l08_case_agreement', data.l08Agreement, l08Cases, 'pass'),
    ratioMetric('cpap_staff_agreement_baseline', data.cpapStaffAgreement, baseline),
  ];
}

export function measureV1(input: unknown) {
  const request = v1ObservationSchema.parse(input);
  const data = request.observations;
  const severe = data.severeReview;
  const mislabelled = m02Ids.some((key) => data.m02Public?.data[key] === 'claimed_confirmed');
  const findings = new Set(severe?.data ?? []);
  if (mislabelled) findings.add('mislabelled_unverified');
  const severityEvidence = [
    ...new Set([
      ...(severe?.evidence ?? []),
      ...(mislabelled ? (data.m02Public?.evidence ?? []) : []),
    ]),
  ];
  const feedback = data.staffFeedback;
  const use = data.staffWeeklyUse;
  const feedbackTotal = feedback
    ? feedback.data.favorable + feedback.data.mixed + feedback.data.unfavorable
    : 0;
  const metrics: Metric[] = [
    ...businessMetrics(data),
    ratioMetric('system_non_model_failures', data.nonModelFailures, (value) =>
      value <= 0.02 ? 'pass' : 'fail',
    ),
    duration('system_first_work_p90', data.firstWorkMs, 5000),
    duration('system_ui_action_p90', data.uiActionMs, 1000),
    completeCheck('safety_checks', data.safetyChecks, safetyIds, 'pass'),
    severe || findings.size
      ? {
          code: 'severe_findings',
          status: findings.size ? 'fail' : 'pass',
          value: findings.size,
          total: null,
          unit: 'count',
          evidence: severityEvidence,
        }
      : pending('severe_findings', 'count'),
    ratioMetric(
      'staff_feedback_baseline',
      feedback
        ? {
            data: { matched: feedback.data.favorable, total: feedbackTotal },
            evidence: feedback.evidence,
          }
        : undefined,
      baseline,
    ),
    use?.data.length
      ? {
          code: 'staff_weekly_use_baseline',
          status: 'baseline',
          value: use.data.reduce((sum, days) => sum + days, 0) / use.data.length,
          total: use.data.length,
          unit: 'days',
          evidence: use.evidence,
        }
      : pending('staff_weekly_use_baseline', 'days', use),
  ];
  return {
    format: 'v1-measurements-v1',
    scope: request.scope,
    head: request.head,
    main: request.main,
    tree: request.tree,
    status: metrics.some((item) => item.status === 'fail')
      ? 'blocked'
      : metrics.some((item) => item.status === 'pending')
        ? 'awaiting_evidence'
        : 'measured',
    severeFindings: severe || findings.size ? [...findings] : null,
    staffFeedbackSummary: feedback?.data ?? null,
    metrics,
  };
}
