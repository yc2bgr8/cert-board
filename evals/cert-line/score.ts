// 来源：参考资料快照 sources/cert-line-assets/eval/score.ts，仅迁移六个认证触点。

import { normalizeQuote, type EvalCase, type Validation } from './contracts.js';

import {
  validateCx,
  validateDr,
  validateDx,
  validatePd,
  validateRg,
  validateRp,
  type CxValue,
  type DrParagraph,
  type DxItem,
  type PdOutput,
  type RgOutput,
} from '../../apps/backend/src/agent/evaluation/cert-line-validate.js';

export function validate(c: EvalCase, o: unknown): Validation<unknown> {
  switch (c.touchpoint) {
    case 'cx':
      return validateCx(o, c.ctx.text!);
    case 'dx':
      return validateDx(o, c.ctx.text!);
    case 'dr':
      return validateDr(o, c.ctx.passages!);
    case 'rg':
      return validateRg(o, new Set(c.ctx.modelCodes!));
    case 'pd':
      return validatePd(o, c.ctx.classification!, c.ctx.results!);
    case 'rp':
      return validateRp(o, c.ctx.facts!);
  }
}

export function score(c: EvalCase, value: unknown): { pass: boolean; reason: string } {
  const kw = c.expect.keywords ?? [];
  switch (c.touchpoint) {
    case 'cx': {
      // 期望字段全部抽到且值一致；没有写的字段（例如软件版本）不应编造
      const got = new Map((value as CxValue[]).map((v) => [v.field, v.value.replace(/\s+/g, '')]));
      const want = c.ctx.cx!;
      const miss = Object.entries(want).filter(
        ([f, v]) => got.get(f as CxValue['field']) !== v.replace(/\s+/g, ''),
      );
      const extra = !('software_version' in want) && got.has('software_version');
      if (extra) return { pass: false, reason: '编造了原文没有的软件版本' };
      return {
        pass: !miss.length,
        reason: miss.length ? `字段不一致：${miss.map(([f]) => f).join('、')}` : '',
      };
    }
    case 'dx': {
      // 每个问题至少有一项的引用落在该问题的原文里（引用该问题的任一句都算）；
      // 同时落在两个问题里的引用（如 "Please provide"）或跨问题的合并引用不算拆出
      const defs = (c.ctx.deficiencies ?? []).map(normalizeQuote);
      const owner = (q: string) => {
        const hits = defs.flatMap((d, i) => (q.length >= 8 && d.includes(q) ? [i] : []));
        return hits.length === 1 ? hits[0]! : -1;
      };
      const covered = new Set(
        (value as { items: DxItem[] }).items.map((x) => owner(normalizeQuote(x.quote))),
      );
      const miss = kw.filter((_, i) => !covered.has(i));
      return { pass: !miss.length, reason: miss.length ? `漏拆 ${miss.length} 项（${miss[0]}）` : '' };
    }
    case 'dr': {
      const cited = (value as { paragraphs: DrParagraph[] }).paragraphs.flatMap((p) =>
        p.citations.map((x) => x.n),
      );
      const ok = cited.includes(c.ctx.relevant!);
      return {
        pass: ok,
        reason: ok ? '' : `没有引用相关段落 [${c.ctx.relevant}]（引用了 ${[...new Set(cited)].join('、')}）`,
      };
    }
    case 'rg': {
      const got = new Set((value as RgOutput).impactModels);
      const want = c.ctx.impact!;
      if (!want.length)
        return {
          pass: !got.size,
          reason: got.size ? `不相关的更新给出了影响型号 ${[...got].join('、')}` : '',
        };
      const miss = want.filter((m) => !got.has(m));
      return { pass: !miss.length, reason: miss.length ? `漏掉影响型号 ${miss.join('、')}` : '' };
    }
    case 'pd': {
      const v = value as PdOutput;
      if (v.classification?.productCode !== c.ctx.productCode)
        return {
          pass: false,
          reason: `分类候选 ${v.classification?.productCode ?? '无'}，期望 ${c.ctx.productCode}`,
        };
      const same = v.predicates.some(
        (p) => c.ctx.results!.find((r) => r.kNumber === p.kNumber)?.productCode === c.ctx.productCode,
      );
      return { pass: same, reason: same ? '' : '没有同产品代码的对比器械候选' };
    }
    case 'rp': {
      const ok = (value as string[]).join('').includes(c.ctx.model!);
      return { pass: ok, reason: ok ? '' : '描述段没有写到型号' };
    }
  }
}

export function mockOutput(c: EvalCase): unknown {
  const kw = c.expect.keywords ?? [];
  switch (c.touchpoint) {
    case 'cx': {
      const lines = c.ctx.text!.split('\n');
      return {
        fields: Object.entries(c.ctx.cx!).map(([field, v]) => ({
          field,
          value: v,
          quote: lines.find((l) => l.includes(v) && !l.startsWith('注：')) ?? '',
        })),
      };
    }
    case 'dx':
      return { items: kw.map((k) => ({ question: `应答：${k}`, quote: k, category: '其他' })) };
    case 'dr': {
      const n = c.ctx.relevant!;
      const text = c.ctx.passages![n - 1]!.text;
      return {
        paragraphs: [
          { text: `Response draft (example). ${text}`, citations: [{ n, quote: text.slice(0, 60) }] },
        ],
      };
    }
    case 'rg':
      return { summary: '示例摘要：官方更新的要点。', impactModels: c.ctx.impact! };
    case 'pd': {
      const cls = c.ctx.classification!.find((x) => x.productCode === c.ctx.productCode)!;
      return {
        classification: {
          productCode: cls.productCode,
          deviceClass: cls.deviceClass,
          regulationNumber: cls.regulationNumber,
          reason: '示例',
        },
        pathway: '510(k) Traditional（候选，需注册A 确认）',
        predicates: [{ kNumber: c.ctx.results![0]!.kNumber, reason: '同产品代码、最近' }],
      };
    }
    case 'rp':
      return { paragraphs: [`${c.ctx.model} 的合规状态以主表为准（示例）。`] };
  }
}
