import { z } from 'zod';
import type { identifierCheckInputSchema } from '@cert-board/shared';
import { AppError } from '../api/errors.js';

type CheckField = z.infer<typeof identifierCheckInputSchema>['field'];
const format: Record<CheckField, RegExp> = {
  k_number: /^K\d{6}$/u,
  product_code: /^[A-Z]{3}$/u,
  regulation_number: /^\d{3}\.\d{4}$/u,
  licence_number: /^\d{1,12}$/u,
  device_identifier: /^[A-Z0-9][A-Z0-9._+/-]{0,49}$/u,
};

export function normalizeIdentifier(field: CheckField, value: string) {
  const identifier = value.normalize('NFC').trim().toUpperCase();
  // 待核稿里的缺字或多字也应进入相似度检查，精确格式由比对对象决定。
  if (!format[field].test(identifier) && !/^[A-Z0-9][A-Z0-9._+/-]{0,49}$/u.test(identifier))
    throw new AppError(400, 'V2_IDENTIFIER_INVALID', '请输入材料中原样出现的一项编号或代码。');
  return identifier;
}

export function identifierInQuote(field: CheckField, identifier: string, quote: string) {
  const token =
    field === 'device_identifier' ? /[A-Z0-9][A-Z0-9._+/-]*/gu : /[A-Z0-9]+(?:\.[A-Z0-9]+)*/gu;
  const identifiers: string[] = quote.toUpperCase().match(token) ?? [];
  return identifiers.includes(identifier);
}

function editDistance(a: string, b: string): number {
  const scores: number[][] = [Array.from({ length: b.length + 1 }, (_, index) => index)];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    const previous = scores[i - 1]!;
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1]! + Number(a[i - 1] !== b[j - 1]);
      const swap =
        i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]
          ? scores[i - 2]![j - 2]! + 1
          : Infinity;
      row.push(Math.min(previous[j]! + 1, row[j - 1]! + 1, substitution, swap));
    }
    scores.push(row);
  }
  return scores[a.length]![b.length]!;
}

export function compareIdentifiers(
  field: CheckField,
  observed: string,
  references: readonly string[],
) {
  const known = [...new Set(references)];
  if (known.some((identifier) => !format[field].test(identifier)))
    throw new AppError(
      422,
      'V2_REFERENCE_FORMAT',
      '比对记录的编号格式与所选类型不符，请核对官方记录或台账列。',
    );
  if (known.includes(observed)) return { status: 'matched' as const, candidates: [] };
  const candidates = known
    .map((identifier) => ({ identifier, edits: editDistance(observed, identifier) }))
    .filter(
      (row): row is { identifier: string; edits: 1 | 2 } => row.edits === 1 || row.edits === 2,
    )
    .sort((a, b) => a.edits - b.edits || a.identifier.localeCompare(b.identifier, 'en'));
  return {
    status: candidates.length ? ('possible_typo' as const) : ('different' as const),
    candidates,
  };
}
