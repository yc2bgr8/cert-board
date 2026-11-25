// 来源：dc_idp/apps/api/src/ai/touchpoints/cert-checks.ts，使用本独立评测的类型和引用纯函数。
/**
 * 认证线 AI 触点的防错校验（纯函数）：线上服务与 AI 评测（PR-71）共用同一套规则。
 *
 * * cx 申报字段抽取：引用必须逐字出现在原文，值必须出现在引用中；不在字段清单内的丢弃。
 * * dx 发补拆项：每项引用必须逐字出现在缺陷信原文（空白折叠后、至少 8 个字符），否则丢弃该项；一项都不剩则整体不通过。
 * * dr 应答底稿：每段至少一处引用，且引用逐字回到检索到的段落，否则丢弃该段；一段都不剩则整体不通过。
 * * rg 法规更新摘要：摘要中不能出现官方源以外的链接；影响型号必须在主表中。
 * * pd 同类产品初判：产品代码、K 号必须在本次 openFDA 结果中；分类等级与法规号以官方记录覆盖。
 * * rp 合规报告描述段：段落中出现的编号与数字必须能在主表事实中找到。
 */
import { z } from 'zod';
import {
  CHECK_FIELDS,
  isOfficialUrl,
  quoteFound,
  type CheckField,
  type ClassificationRow,
  type PredicateRow,
  type Validation,
} from '../../../../../evals/cert-line/contracts.js';

// ---------------- cx ----------------

const cxSchema = z.object({
  fields: z
    .array(z.object({ field: z.string(), value: z.string().min(1), quote: z.string().min(1) }))
    .max(40),
});
export interface CxValue {
  field: CheckField;
  value: string;
  quote: string;
}
export function validateCx(output: unknown, source: string): Validation<CxValue[]> {
  const p = cxSchema.safeParse(output);
  if (!p.success) return { ok: false, reason: 'output schema' };
  const kept: CxValue[] = [];
  const notes: string[] = [];
  for (const f of p.data.fields) {
    if (!(CHECK_FIELDS as readonly string[]).includes(f.field)) continue;
    if (!source.includes(f.quote) || !f.quote.includes(f.value)) {
      notes.push(`丢弃 ${f.field}：引用不在原文中`);
      continue;
    }
    kept.push({ field: f.field as CheckField, value: f.value, quote: f.quote });
  }
  return { ok: true, value: kept, notes };
}

// ---------------- dx ----------------

const dxSchema = z.object({
  items: z
    .array(
      z.object({
        question: z.string().min(1).max(4000),
        quote: z.string().max(4000),
        category: z.string().max(100).default(''),
      }),
    )
    .max(60),
});
export type DxItem = z.output<typeof dxSchema>['items'][number];
export function validateDx(
  output: unknown,
  letter: string,
): Validation<{ items: DxItem[]; dropped: number }> {
  const p = dxSchema.safeParse(output);
  if (!p.success) return { ok: false, reason: 'output schema' };
  const items = p.data.items.filter((x) => quoteFound(letter, x.quote));
  if (!items.length) return { ok: false, reason: '没有一项的引用能在原文中找到' };
  return { ok: true, value: { items, dropped: p.data.items.length - items.length } };
}

// ---------------- dr ----------------

const drSchema = z.object({
  paragraphs: z
    .array(
      z.object({
        text: z.string().min(1).max(3000),
        citations: z
          .array(z.object({ n: z.number().int(), quote: z.string().max(1000) }))
          .max(6)
          .default([]),
      }),
    )
    .min(1)
    .max(8),
});
export type DrParagraph = z.output<typeof drSchema>['paragraphs'][number];
export function validateDr(
  output: unknown,
  passages: { text: string }[],
): Validation<{ paragraphs: DrParagraph[]; dropped: number }> {
  const p = drSchema.safeParse(output);
  if (!p.success) return { ok: false, reason: 'output schema' };
  const paragraphs = p.data.paragraphs.filter(
    (para) =>
      para.citations.length > 0 &&
      para.citations.every((c) => {
        const hit = passages[c.n - 1];
        return !!hit && quoteFound(hit.text, c.quote);
      }),
  );
  if (!paragraphs.length) return { ok: false, reason: '没有一段的引用能回到检索到的原文' };
  return { ok: true, value: { paragraphs, dropped: p.data.paragraphs.length - paragraphs.length } };
}

// ---------------- rg ----------------

const rgSchema = z.object({
  summary: z.string().min(1).max(1500),
  impactModels: z.array(z.string()).max(20).default([]),
});
export type RgOutput = z.output<typeof rgSchema>;
export function validateRg(output: unknown, modelCodes: Set<string>): Validation<RgOutput> {
  const p = rgSchema.safeParse(output);
  if (!p.success) return { ok: false, reason: 'output schema' };
  const links = p.data.summary.match(/https?:\/\/[^\s)）"'，。]+/g) ?? [];
  const bad = links.filter((l) => !isOfficialUrl(l));
  if (bad.length) return { ok: false, reason: `摘要中出现官方源以外的链接：${bad[0]}` };
  const unknown = p.data.impactModels.filter((c) => !modelCodes.has(c));
  if (unknown.length) return { ok: false, reason: `影响型号不在主表中：${unknown.slice(0, 3).join('、')}` };
  return { ok: true, value: p.data };
}

// ---------------- pd ----------------

const pdSchema = z.object({
  classification: z
    .object({
      productCode: z.string(),
      deviceClass: z.string(),
      regulationNumber: z.string().default(''),
      reason: z.string().max(600),
    })
    .nullable()
    .default(null),
  pathway: z.string().max(600),
  predicates: z
    .array(z.object({ kNumber: z.string(), reason: z.string().max(400) }))
    .max(5)
    .default([]),
});
export type PdOutput = z.output<typeof pdSchema>;
export function validatePd(
  output: unknown,
  classification: ClassificationRow[],
  results: PredicateRow[],
): Validation<PdOutput> {
  const p = pdSchema.safeParse(output);
  if (!p.success) return { ok: false, reason: 'output schema' };
  const codes = new Map(classification.map((c) => [c.productCode, c]));
  const ks = new Set(results.map((r) => r.kNumber));
  const c = p.data.classification;
  if (c) {
    const official = codes.get(c.productCode);
    if (!official) return { ok: false, reason: `产品代码 ${c.productCode} 不在官方分类结果中` };
    c.deviceClass = official.deviceClass;
    c.regulationNumber = official.regulationNumber;
  }
  const bad = p.data.predicates.filter((x) => !ks.has(x.kNumber.toUpperCase()));
  if (bad.length) return { ok: false, reason: `对比器械不在 510(k) 查询结果中：${bad[0]!.kNumber}` };
  return {
    ok: true,
    value: {
      ...p.data,
      predicates: p.data.predicates.map((x) => ({ ...x, kNumber: x.kNumber.toUpperCase() })),
    },
  };
}

// ---------------- rp ----------------

const rpSchema = z.object({ paragraphs: z.array(z.string().min(1).max(1200)).min(1).max(3) });
export function validateRp(output: unknown, facts: string): Validation<string[]> {
  const p = rpSchema.safeParse(output);
  if (!p.success) return { ok: false, reason: 'output schema' };
  // 段落中的编号、日期（含数字的词）都必须出现在事实字段里
  const tokens = (s: string) =>
    (s.replace(/[–—]/g, '-').match(/[A-Z0-9]+(?:[().\-/][A-Z0-9]+)*\)?/gi) ?? [])
      .filter((t) => /\d/.test(t))
      .map((t) => (t.includes('(') ? t : t.replace(/\)$/, '')).toLowerCase());
  const allowed = new Set(tokens(facts));
  const unknown = tokens(p.data.paragraphs.join(' ')).filter((t) => !allowed.has(t));
  if (unknown.length)
    return { ok: false, reason: `段落中出现主表以外的编号或数字：${unknown.slice(0, 3).join('、')}` };
  return { ok: true, value: p.data.paragraphs };
}
