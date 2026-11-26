import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { certEvalCases } from '../../../../../evals/cert-line/cases.js';
import { certLinePromptHashes } from './cert-line-run.js';

const touchpoints = ['cx', 'dx', 'dr', 'rg', 'pd', 'rp'] as const;
const expected = certEvalCases();
const flashByTouchpoint = { cx: 20, dx: 20, dr: 20, rg: 16, pd: 20, rp: 20 };
const resultSchema = z.object({
  id: z.string(),
  touchpoint: z.enum(touchpoints),
  valid: z.boolean(),
  pass: z.boolean(),
  costUsd: z.number().finite().nonnegative().nullish(),
  settledUsd: z
    .string()
    .regex(/^\d{1,15}(?:\.\d{1,9})?$/u)
    .optional(),
  reasonCode: z.enum(['invalid_json', 'validation_failed', 'score_failed']).nullish(),
});
const reportSchema = z.object({
  date: z.iso.date(),
  model: z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,79}(?::[a-z0-9._-]+)?$/iu),
  mock: z.literal(false),
  status: z.literal('completed').optional(),
  promptHashes: z
    .record(z.string().regex(/^[a-z_]+$/u), z.string().regex(/^[a-f0-9]{64}$/u))
    .optional(),
  results: z.array(resultSchema).length(expected.length),
});

type Result = z.infer<typeof resultSchema>;

function readReport(input: unknown) {
  const parsed = reportSchema.safeParse(input);
  if (!parsed.success) throw new Error('需要完整的认证线真实运行记录。');
  const results = new Map(parsed.data.results.map((row) => [row.id, row]));
  if (results.size !== expected.length) throw new Error('运行记录包含重复用例。');
  for (const item of expected) {
    const row = results.get(item.id);
    if (!row || row.touchpoint !== item.touchpoint || (row.pass && !row.valid))
      throw new Error('运行记录与用例目录或判分状态不一致。');
  }
  return { ...parsed.data, byId: results };
}

function resultState(row: Result) {
  if (row.pass) return 'passed';
  return row.valid ? 'failed' : 'invalid';
}

export function compareCertLineReports(candidateInput: unknown, baselineInput?: unknown) {
  const candidate = readReport(candidateInput);
  const baseline = baselineInput === undefined ? undefined : readReport(baselineInput);
  const keys = Object.keys(certLinePromptHashes);
  const candidateHashes = candidate.promptHashes;
  const baselineHashes = baseline?.promptHashes;
  const promptComparability =
    candidateHashes &&
    baselineHashes &&
    keys.every((key) => candidateHashes[key] && baselineHashes[key])
      ? keys.every((key) => candidateHashes[key] === baselineHashes[key])
        ? ('matched' as const)
        : ('mismatch' as const)
      : ('unverified' as const);
  const byTouchpoint = touchpoints.map((touchpoint) => {
    const rows = candidate.results.filter((row) => row.touchpoint === touchpoint);
    const baselinePassed = baseline
      ? baseline.results.filter((row) => row.touchpoint === touchpoint && row.pass).length
      : flashByTouchpoint[touchpoint];
    const passed = rows.filter((row) => row.pass).length;
    return {
      touchpoint,
      cases: rows.length,
      passed,
      baselinePassed,
      delta: passed - baselinePassed,
    };
  });
  const cases = expected.map(({ id }) => {
    const row = candidate.byId.get(id)!;
    return {
      id,
      touchpoint: row.touchpoint,
      state: resultState(row),
      ...(row.reasonCode ? { reasonCode: row.reasonCode } : {}),
    };
  });
  const changes = baseline
    ? cases.flatMap(({ id, touchpoint, state }) => {
        const previous = resultState(baseline.byId.get(id)!);
        return previous === state ? [] : [{ id, touchpoint, previous, current: state }];
      })
    : null;
  const priced = candidate.results.flatMap(({ costUsd, settledUsd }) => {
    if (costUsd != null) return [costUsd];
    return settledUsd && Number(settledUsd) > 0 ? [Number(settledUsd)] : [];
  });
  return {
    candidate: { model: candidate.model, date: candidate.date },
    baseline: baseline
      ? { level: 'case' as const, model: baseline.model, date: baseline.date }
      : { level: 'aggregate' as const, model: 'qwen/qwen3.8-flash', date: '2026-11-16' },
    promptComparability,
    totals: {
      cases: cases.length,
      passed: byTouchpoint.reduce((total, group) => total + group.passed, 0),
      baselinePassed: byTouchpoint.reduce((total, group) => total + group.baselinePassed, 0),
      knownCostUsd: priced.length
        ? String(Number(priced.reduce((sum, cost) => sum + cost, 0).toFixed(9)))
        : null,
      unpricedCases: candidate.results.filter(({ costUsd }) => costUsd == null).length,
    },
    byTouchpoint,
    failedCases: cases.filter(({ state }) => state !== 'passed'),
    changes,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [candidate, baseline, extra] = process.argv.slice(2);
    if (!candidate || extra)
      throw new Error('使用 pnpm eval:cert-line:compare <运行报告> [逐例基线]。');
    const load = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as unknown;
    const report = compareCertLineReports(
      await load(candidate),
      baseline ? await load(baseline) : undefined,
    );
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const safe = /^(需要完整|运行记录|使用 pnpm)/u.test(message);
    console.error(safe ? message : '无法读取评测报告，请检查路径和 JSON 格式。');
    process.exitCode = 1;
  }
}
