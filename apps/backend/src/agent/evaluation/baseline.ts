import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { decimalUsdSchema } from '@cert-board/shared';
import { nanoToUsd, usdToNano } from '../../budget/meter.js';

const primaryModel = 'openai/gpt-6.2-astra-pro';
const sha = z.string().regex(/^[0-9a-f]{40}$/u);
const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9][a-z0-9_.:/-]*$/u);
const count = z.number().int().nonnegative().safe();
const requiredTools = ['doc_read', 'skill_load', 'plan_update', 'check_run', 'submit_for_review'];
const reviewedCase = z.object({
  url: z.string().startsWith('http://127.0.0.1:28280/?conversation='),
  tools: z
    .array(identifier)
    .max(64)
    .refine((names) => requiredTools.every((name) => names.includes(name))),
});
const reportSchema = z.object({
  status: z.literal('passed'),
  scope: z.literal('business'),
  head: sha,
  base: sha,
  mergeTree: sha,
  testCommit: sha,
  completedAt: z.string().datetime({ offset: true }),
  steps: z
    .array(z.object({ name: identifier, exitCode: z.literal(0), seconds: count }))
    .min(1)
    .max(64),
});
const resultSchema = z.object({
  status: z.literal('passed'),
  commit: sha,
  errorId: z.uuid(),
  registration: reviewedCase,
  maintenance: reviewedCase,
  verification: z.object({
    channels: z
      .array(
        z.object({
          channel: z.enum(['cursor', 'gateway']),
          model: identifier,
          status: z.literal('settled'),
        }),
      )
      .length(2),
  }),
  cost: z
    .array(
      z
        .object({ model: identifier, calls: count, unknown: count, usd: decimalUsdSchema })
        .refine(({ calls, unknown }) => unknown <= calls),
    )
    .min(1)
    .max(16),
});

export function summarizeAgentBaseline(rawReport: unknown, rawResult: unknown) {
  const report = reportSchema.parse(rawReport);
  const result = resultSchema.parse(rawResult);
  const steps = report.steps.filter(({ name }) => name === 'walkthrough');
  const channels = result.verification.channels;
  const models = result.cost.map(({ model }) => model);
  if (
    result.commit !== report.testCommit ||
    steps.length !== 1 ||
    new Set(channels.map(({ channel }) => channel)).size !== 2 ||
    new Set(models).size !== models.length ||
    !result.cost.some(({ model, calls }) => model === primaryModel && calls > 0)
  )
    throw new Error('真实模型走查的身份、专项或计量记录不匹配。');

  return {
    primaryModel,
    completedAt: report.completedAt,
    base: report.base,
    head: report.head,
    mergeTree: report.mergeTree,
    testCommit: report.testCommit,
    durationSeconds: steps[0]!.seconds,
    cases: [
      { id: 'R09', status: 'passed', tools: [...result.registration.tools].sort() },
      { id: 'M02', status: 'passed', tools: [...result.maintenance.tools].sort() },
    ],
    verification: channels.map(({ channel, model }) => ({ channel, model })),
    errorNumberLinkedToLog: true,
    requests: result.cost.reduce((total, row) => total + row.calls, 0),
    unsettledRequests: result.cost.reduce((total, row) => total + row.unknown, 0),
    settledUsd: nanoToUsd(result.cost.reduce((total, row) => total + usdToNano(row.usd), 0n)),
    cost: [...result.cost].sort((a, b) => a.model.localeCompare(b.model, 'en')),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = process.argv.slice(2);
  if (paths.length !== 2) {
    console.error('请提供通过的虚拟机 report.json 和标准真实走查 result.json。');
    process.exitCode = 2;
  } else {
    try {
      const [report, result] = paths.map(
        (file) => JSON.parse(readFileSync(file, 'utf8')) as unknown,
      );
      console.log(JSON.stringify(summarizeAgentBaseline(report, result), null, 2));
    } catch {
      console.error('真实回归基线未生成，请核对同一提交的虚拟机报告和标准走查回执。');
      process.exitCode = 1;
    }
  }
}
