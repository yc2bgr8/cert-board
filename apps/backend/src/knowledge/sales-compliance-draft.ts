import { createHash } from 'node:crypto';
import { confirmedFactSchema, type ConfirmedFact } from '@cert-board/shared';
import { z } from 'zod';

const field = z.enum([
  'device_model',
  'certificate_number',
  'expiry_date',
  'standard_number',
  'market_status',
]);
type Field = z.infer<typeof field>;
const labels: Record<Field, string> = {
  device_model: '型号',
  certificate_number: '证照编号',
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
    .max(5)
    .refine((items) => new Set(items.map(({ field }) => field)).size === items.length),
  facts: z
    .array(
      z.strictObject({ fact: confirmedFactSchema, level: z.enum(['internal', 'confidential']) }),
    )
    .max(60),
  clearances: clearance.array().max(60),
});

type Issue = { field: Field; reason: 'missing' | 'not_approved' | 'source_invalid' | 'mismatch' };
type ReadSource = (location: Omit<ConfirmedFact['evidence'], 'quote'>) => Promise<string | null>;
const approvalKey = (factId: string, revision: number) => `${factId.toLowerCase()}:${revision}`;
const safeText = (value: string) =>
  value.replace(/[\r\n]+/gu, ' ').replace(/[!-/:-@[-`{-~]/gu, '\\$&');

function verifiedField(page: string | null, quote: string, field: Field, value: string) {
  const line = /^\s*([^:：\r\n]+)[:：][ \t]*([^\r\n]+)$/u.exec(quote);
  return (
    line !== null &&
    [field, labels[field]].includes(line[1]!.trim()) &&
    line[2]!.trim() === value &&
    page?.split(/\r?\n/u).includes(quote) === true
  );
}

export async function buildSyntheticSalesComplianceDraft(input: unknown, readSource: ReadSource) {
  const request = requestSchema.parse(input);
  const latest = new Map<string, (typeof request.facts)[number]>();
  const seen = new Set<string>();
  for (const item of request.facts) {
    if (item.fact.subject !== request.subject) continue;
    const key = `${item.fact.field}:${item.fact.revision}`;
    if (seen.has(key)) throw new Error('主数据有重复修订，请核对后重新生成草稿。');
    seen.add(key);
    if ((latest.get(item.fact.field)?.fact.revision ?? 0) < item.fact.revision)
      latest.set(item.fact.field, item);
  }
  const allowed = new Set(
    request.clearances.map((item) => approvalKey(item.factId, item.revision)),
  );
  const now = Date.parse(request.asOf);
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
    if (
      !found ||
      Date.parse(found.fact.validFrom) > now ||
      (found.fact.validUntil !== null && Date.parse(found.fact.validUntil) <= now)
    ) {
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
      (field === 'expiry_date' && !z.iso.date().safeParse(fact.value).success)
    ) {
      issues.push({ field, reason: 'source_invalid' });
      continue;
    }
    const { quote, ...source } = fact.evidence;
    const value = fact.value;
    if (!verifiedField(await readSource(source), quote, field, value)) {
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
