import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { decimalUsdSchema } from '@cert-board/shared';
import { nanoToUsd, usdToNano } from '../../budget/meter.js';

const modelProfiles = {
  openrouter: { primary: 'openai/gpt-6.2-astra-pro', peer: 'anthropic/claude-opus-5.5' },
  'cursor-acp': { primary: 'cursor/gpt-5.6-sol', peer: 'cursor/claude-opus-5.5' },
} as const;
const costModel = z.enum([
  modelProfiles.openrouter.primary,
  modelProfiles.openrouter.peer,
  modelProfiles['cursor-acp'].primary,
  modelProfiles['cursor-acp'].peer,
]);
const sha = z.string().regex(/^[0-9a-f]{40}$/u);
const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9][a-z0-9_.:/-]*$/u);
const count = z.number().int().nonnegative().safe();
const requiredTools = ['doc_read', 'skill_load', 'plan_update', 'check_run', 'submit_for_review'];
const conversationUrl = 'http://127.0.0.1:28280/?conversation=';
const receiptLogPrefix = '标准走查回执 ';
const reviewedCase = z.object({
  url: z
    .string()
    .startsWith(conversationUrl)
    .refine((url) => z.uuid().safeParse(url.slice(conversationUrl.length)).success),
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
  startedAt: z.string().datetime({ offset: true }),
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
  modelTransport: z.enum(['openrouter', 'cursor-acp']).default('openrouter'),
  mainModel: costModel.optional(),
  registration: reviewedCase,
  maintenance: reviewedCase,
  verification: z.object({
    gatewayTransport: z.enum(['openrouter', 'cursor-acp']).default('openrouter'),
    channels: z
      .array(
        z.discriminatedUnion('channel', [
          z.object({
            channel: z.literal('cursor'),
            model: z.literal('grok-4-7'),
            status: z.literal('settled'),
          }),
          z.object({
            channel: z.literal('gateway'),
            model: z.literal('claude-opus-5-5-gateway'),
            status: z.enum(['settled', 'unknown']),
          }),
        ]),
      )
      .length(2),
  }),
  cost: z
    .array(
      z
        .object({
          model: costModel,
          calls: count.positive(),
          unknown: count,
          usd: decimalUsdSchema,
        })
        .refine(({ calls, unknown }) => unknown <= calls),
    )
    .length(2),
});
const proofReceiptSchema = z.object({
  status: z.literal('passed'),
  commit: sha,
  evidence: z.string().min(1),
  resultSha256: z.string().regex(/^[0-9a-f]{64}$/u),
});

type EvidenceInterval = { startedAt: number; completedAt: number };

export function summarizeAgentBaseline(
  rawReport: unknown,
  rawResult: unknown,
  evidence: EvidenceInterval,
) {
  const report = reportSchema.parse(rawReport);
  const result = resultSchema.parse(rawResult);
  const steps = report.steps.filter(({ name }) => name === 'walkthrough');
  const channels = result.verification.channels;
  const models = result.cost.map(({ model }) => model);
  const profile = modelProfiles[result.modelTransport];
  const gatewayStatus = channels.find(({ channel }) => channel === 'gateway')?.status;
  const registrationId = result.registration.url.slice(conversationUrl.length).toLowerCase();
  const maintenanceId = result.maintenance.url.slice(conversationUrl.length).toLowerCase();
  if (
    result.commit !== report.testCommit ||
    steps.length !== 1 ||
    registrationId === maintenanceId ||
    !Number.isFinite(evidence.startedAt) ||
    !Number.isFinite(evidence.completedAt) ||
    evidence.startedAt > evidence.completedAt ||
    evidence.startedAt < Date.parse(report.startedAt) ||
    evidence.completedAt > Date.parse(report.completedAt) ||
    evidence.completedAt - evidence.startedAt > (steps[0]!.seconds + 1) * 1000 ||
    new Set(channels.map(({ channel }) => channel)).size !== 2 ||
    new Set(models).size !== models.length ||
    models.some((model) => model !== profile.primary && model !== profile.peer) ||
    !result.cost.some(({ model, calls }) => model === profile.primary && calls >= 2) ||
    result.verification.gatewayTransport !== result.modelTransport ||
    ((result.modelTransport === 'cursor-acp' || result.mainModel !== undefined) &&
      result.mainModel !== profile.primary) ||
    (result.modelTransport === 'openrouter' &&
      channels.some(({ status }) => status !== 'settled')) ||
    (result.modelTransport === 'cursor-acp' &&
      (gatewayStatus !== 'unknown' ||
        !result.cost.some(({ model, unknown }) => model === profile.peer && unknown > 0)))
  )
    throw new Error('真实模型走查的身份、专项或计量记录不匹配。');

  return {
    primaryModel: profile.primary,
    modelTransport: result.modelTransport,
    completedAt: report.completedAt,
    base: report.base,
    head: report.head,
    mergeTree: report.mergeTree,
    testCommit: report.testCommit,
    durationSeconds: steps[0]!.seconds,
    cases: [
      { id: 'R09', status: 'passed', tools: [...requiredTools] },
      { id: 'M02', status: 'passed', tools: [...requiredTools] },
    ],
    verification: channels.map(({ channel, model }) => ({ channel, model })),
    errorNumberLinkedToLog: true,
    requests: result.cost.reduce((total, row) => total + row.calls, 0),
    unsettledRequests: result.cost.reduce((total, row) => total + row.unknown, 0),
    settledUsd: nanoToUsd(result.cost.reduce((total, row) => total + usdToNano(row.usd), 0n)),
    cost: [...result.cost].sort((a, b) => a.model.localeCompare(b.model, 'en')),
  };
}

export function readBaselineFiles(reportFile: string, resultFile: string) {
  const reportPath = realpathSync(reportFile);
  const resultPath = realpathSync(resultFile);
  const acceptanceDir = path.dirname(reportPath);
  const preview = path.join(acceptanceDir, 'source', '.local', 'preview');
  const root = path.join(preview, 'evidence');
  const [folder, name, ...rest] = path.relative(root, resultPath).split(path.sep);
  const timestamp = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/u.exec(folder ?? '');
  if (
    path.basename(reportPath) !== 'report.json' ||
    name !== 'result.json' ||
    rest.length ||
    !timestamp
  )
    throw new Error('请使用同一次虚拟机验收保留的原目录。');
  const [, hour, minute, second, fraction] = timestamp;
  const receiptPath = path.join(path.dirname(resultPath), 'receipt.json');
  const receipt = proofReceiptSchema.parse(JSON.parse(readFileSync(receiptPath, 'utf8')));
  const recordedReceipts = readFileSync(path.join(acceptanceDir, 'walkthrough.log'), 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(receiptLogPrefix));
  if (
    recordedReceipts.length !== 1 ||
    recordedReceipts[0] !== `${receiptLogPrefix}${folder} ${receipt.resultSha256}`
  )
    throw new Error('没有找到本次虚拟机走查步骤记录的回执。');
  const rawResult = readFileSync(resultPath);
  const completedAt = statSync(resultPath).mtimeMs;
  const baseline = summarizeAgentBaseline(
    JSON.parse(readFileSync(reportPath, 'utf8')) as unknown,
    JSON.parse(rawResult.toString('utf8')) as unknown,
    { startedAt: Date.parse(`${hour}:${minute}:${second}.${fraction}Z`), completedAt },
  );
  const issuedAt = statSync(receiptPath).mtimeMs;
  if (
    receipt.commit !== baseline.testCommit ||
    realpathSync(receipt.evidence) !== path.dirname(resultPath) ||
    issuedAt < completedAt ||
    issuedAt > Date.parse(baseline.completedAt) ||
    createHash('sha256').update(rawResult).digest('hex') !== receipt.resultSha256
  )
    throw new Error('标准走查回执与结果不匹配。');
  return baseline;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = process.argv.slice(2);
  if (paths.length !== 2) {
    console.error('请提供通过的虚拟机 report.json 和标准真实走查 result.json。');
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(readBaselineFiles(paths[0]!, paths[1]!), null, 2));
    } catch {
      console.error('真实回归基线未生成，请核对同一提交的虚拟机报告和标准走查回执。');
      process.exitCode = 1;
    }
  }
}
