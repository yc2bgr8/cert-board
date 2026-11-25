import { createHash } from 'node:crypto';
import {
  confirmedFactSchema,
  documentCitationSchema,
  type ConfirmedFact,
} from '@cert-board/shared';
import { z } from 'zod';

const field = z.enum([
  'device_model',
  'certificate_number',
  'submission_number',
  'expiry_date',
  'standard_number',
  'market_status',
]);
type Field = z.infer<typeof field>;
const labels: Record<Field, string> = {
  device_model: '型号',
  certificate_number: '证照编号',
  submission_number: '申报编号',
  expiry_date: '有效期截止日',
  standard_number: '标准号',
  market_status: '市场授权状态',
};
const dateTime = z.iso.datetime({ offset: true });
const clearance = z.strictObject({
  factId: z.uuid(),
  revision: z.number().int().positive(),
  decision: z.literal('allow_sales_draft'),
});
const row = z.strictObject({
  field,
  reportedValue: z.union([z.string().trim().max(600), z.number().finite(), z.boolean()]).optional(),
  reportedUnit: z.string().trim().max(32).nullable().optional(),
});
const requestSchema = z.strictObject({
  synthetic: z.literal(true),
  subject: z.string().trim().min(1).max(120),
  asOf: dateTime,
  fields: row
    .array()
    .min(1)
    .max(6)
    .refine((items) => new Set(items.map(({ field }) => field)).size === items.length),
  facts: z
    .array(
      z.strictObject({ fact: confirmedFactSchema, level: z.enum(['internal', 'confidential']) }),
    )
    .max(60),
  clearances: clearance.array().max(60),
});

type Issue = { field: Field; reason: 'missing' | 'not_approved' | 'source_invalid' | 'mismatch' };
type Location = Omit<ConfirmedFact['evidence'], 'quote'>;
type Source = { subject: string; level: 'internal' | 'confidential'; readText(): Promise<string> };
type DescribeSource = (location: Location) => Promise<Source | null>;
const placeholder =
  /^(?:待核(?:对|实)?|待确认|待发放|未发放|未取得|未说明|未知|不适用|n\/?a|tbd|[-—–]+)$/iu;
export const salesSourceKey = ({ documentId, version, page }: Location) =>
  `${documentId.toLowerCase()}:${version}:${page}`;
export const syntheticSalesSourceManifest = documentCitationSchema
  .omit({ quote: true })
  .extend({
    subject: z.string().trim().min(1).max(120),
    level: z.enum(['internal', 'confidential']),
    bodyFile: z.string().regex(/^[a-z0-9-]+\.txt$/u),
  })
  .array()
  .max(12)
  .refine((pages) => new Set(pages.map(salesSourceKey)).size === pages.length);
const approvalKey = (factId: string, revision: number) => `${factId.toLowerCase()}:${revision}`;
const safeText = (value: string) =>
  value.replace(/[\r\n]+/gu, ' ').replace(/[!-/:-@[-`{-~]/gu, '\\$&');

function verifiedField(page: string, quote: string, subject: string, field: Field, value: string) {
  const labelsInPage = page.split(/\r?\n/u).flatMap((line) => {
    const found = /^\s*([^:：\r\n]+)[:：][ \t]*([^\r\n]+)$/u.exec(line);
    return found ? [{ label: found[1]!.trim(), value: found[2]!.trim(), line }] : [];
  });
  const subjects = new Set(
    labelsInPage
      .filter(({ label }) => label === '对象' || label === 'subject')
      .map((item) => item.value),
  );
  if (subjects.size !== 1 || !subjects.has(subject)) return false;
  const matches = labelsInPage.filter(({ label }) => label === field || label === labels[field]);
  return (
    matches.some((entry) => entry.line === quote) && matches.every((entry) => entry.value === value)
  );
}

export async function buildSyntheticSalesComplianceDraft(
  input: unknown,
  describeSource: DescribeSource,
) {
  const request = requestSchema.parse(input);
  const now = Date.parse(request.asOf);
  const latest = new Map<string, (typeof request.facts)[number]>();
  const seen = new Set<string>();
  const factKeys = new Set<string>();
  for (const item of request.facts) {
    const factKey = approvalKey(item.fact.id, item.fact.revision);
    if (factKeys.has(factKey)) throw new Error('主数据有重复修订，请核对后重新生成草稿。');
    factKeys.add(factKey);
    if (item.fact.subject !== request.subject) continue;
    const key = `${item.fact.field}:${item.fact.revision}`;
    if (seen.has(key)) throw new Error('主数据有重复修订，请核对后重新生成草稿。');
    seen.add(key);
    if (Date.parse(item.fact.validFrom) > now) continue;
    if ((latest.get(item.fact.field)?.fact.revision ?? 0) < item.fact.revision)
      latest.set(item.fact.field, item);
  }
  const allowed = new Set(
    request.clearances.map((item) => approvalKey(item.factId, item.revision)),
  );
  const issues: Issue[] = [];
  const references: {
    field: Field;
    factId: string;
    revision: number;
    source: Omit<ConfirmedFact['evidence'], 'quote'>;
  }[] = [];
  const lines = ['# 销售合规报告草稿', '合成演练。待注册人员审核。'];
  for (const requested of request.fields) {
    const found = latest.get(requested.field);
    const { field } = requested;
    if (!found || (found.fact.validUntil !== null && Date.parse(found.fact.validUntil) <= now)) {
      issues.push({ field, reason: 'missing' });
      continue;
    }
    const fact = found.fact;
    if (found.level !== 'internal' || !allowed.has(approvalKey(fact.id, fact.revision))) {
      issues.push({ field, reason: 'not_approved' });
      continue;
    }
    if (
      typeof fact.value !== 'string' ||
      fact.unit !== null ||
      placeholder.test(fact.value) ||
      (field === 'expiry_date' && !z.iso.date().safeParse(fact.value).success)
    ) {
      issues.push({ field, reason: 'source_invalid' });
      continue;
    }
    const { quote, ...source } = fact.evidence;
    const value = fact.value;
    const metadata = await describeSource(source);
    if (metadata?.level === 'confidential') {
      issues.push({ field, reason: 'not_approved' });
      continue;
    }
    if (
      !metadata ||
      metadata.subject !== request.subject ||
      !verifiedField(await metadata.readText(), quote, request.subject, field, value)
    ) {
      issues.push({ field, reason: 'source_invalid' });
      continue;
    }
    if (
      (requested.reportedValue !== undefined && requested.reportedValue !== fact.value) ||
      (requested.reportedUnit !== undefined && requested.reportedUnit !== fact.unit)
    )
      issues.push({ field, reason: 'mismatch' });
    references.push({ field, factId: fact.id, revision: fact.revision, source });
    lines.push(`- ${labels[field]} ${safeText(value)}（来源 ${references.length}）`);
  }
  if (issues.length) {
    lines.push('## 待核项');
    const message: Record<Issue['reason'], string> = {
      missing: '缺少当前主数据',
      not_approved: '待核对可用范围',
      source_invalid: '原文出处待重读',
      mismatch: '来稿与当前确认记录不一致',
    };
    for (const issue of issues) lines.push(`- ${labels[issue.field]} ${message[issue.reason]}`);
  }
  const markdown = lines.join('\n\n') + '\n';
  return {
    markdown,
    sources: {
      synthetic: true,
      publication: 'draft',
      asOf: request.asOf,
      reportSha256: createHash('sha256').update(markdown).digest('hex'),
      references,
    },
    issues,
  };
}
