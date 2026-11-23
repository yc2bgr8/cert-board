import type { StructuredSubmission } from '@cert-board/shared';
import { normalizeWhitespace } from './quotes.js';

type Claim = StructuredSubmission['claims'][number];
type Unit = { family: string; scale: bigint };
const definitions = [
  ['length', 1n, ['mm', '毫米']],
  ['length', 10n, ['cm', '厘米']],
  ['duration', 1n, ['s', 'sec', 'second', 'seconds', '秒']],
  ['duration', 60n, ['min', 'minute', 'minutes', '分钟']],
  ['duration', 3600n, ['h', 'hr', 'hour', 'hours', '小时']],
  ['duration', 86400n, ['day', 'days', '天']],
  ['calendar_months', 1n, ['month', 'months', '个月', '月']],
  ['calendar_months', 12n, ['year', 'years', '年']],
  ['temperature_c', 1n, ['°C', '℃', '摄氏度']],
  ['pressure_cm_water', 1n, ['cmH2O', 'cmH₂O']],
  ['voltage', 1n, ['V', 'volt', 'volts']],
  ['mass', 1n, ['g', '克']],
  ['mass', 1000n, ['kg', '千克']],
  ['volume', 1n, ['mL', 'ml', '毫升']],
  ['volume', 1000n, ['L', 'l', '升']],
] as const;
const unitNames = new Set([
  'second',
  'seconds',
  'minute',
  'minutes',
  'hour',
  'hours',
  'day',
  'days',
  'month',
  'months',
  'year',
  'years',
  'volt',
  'volts',
]);
function unitKey(value: string) {
  const normalized = value.normalize('NFKC').replace(/\s+/gu, '');
  const lower = normalized.toLowerCase();
  return unitNames.has(lower) ? lower : normalized;
}
const units = new Map<string, Unit>(
  definitions.flatMap(([family, scale, labels]) =>
    labels.map((label) => [unitKey(label), { family, scale }] as const),
  ),
);
const chineseUnits = definitions
  .flatMap(([, , labels]) => labels)
  .filter((label) => /^\p{Script=Han}/u.test(label))
  .sort((a, b) => b.length - a.length)
  .join('|');
const gap = '[ \\t\\n\\u00a0\\u202f]*';
const numberBoundary = '(?<![A-Za-z0-9.+−-])(?<!\\d[,， \\u00a0\\u202f])';
const compoundTail = `(?:${gap}(?:[/⁄／∕^⋅·×÷±+]|\\b(?:per|x)\\b|(?<=\\d)x(?=\\d))|${gap}[*＊]${gap}(?=[(\\[{\\p{L}\\p{N}°℃+−-]|\\.\\d))`;
const unitBoundary = `(?![A-Za-z\\p{N}⁻])(?!${compoundTail})`;
const decimal = '[+−-]?(?:\\d{1,3}(?:[,，]\\d{3}){1,2}|\\d{1,9})(?:\\.\\d{1,6})?';
const rangeSeparator = '(?:-|−|–|—|~|～|至|to\\b)';
const unitAtom = `(?:cm${gap}h[2₂]o|°${gap}[A-Za-z]|℃|${chineseUnits}|[A-Za-zµμΩ%][A-Za-z\\p{N}µμΩ]*)[\\p{N}^⁻]*`;
const unitLexeme = `(?!to\\b)${unitAtom}`;
const compoundQuantity = new RegExp(
  `${numberBoundary}${decimal}(?:${gap}${unitLexeme})?${compoundTail}`,
  'iu',
);
const submitted = new RegExp(`^(${decimal})(?:${gap}${rangeSeparator}${gap}(${decimal}))?$`, 'iu');
const sourceRange = new RegExp(
  `${numberBoundary}(${decimal})${gap}(${unitLexeme})?${gap}(${rangeSeparator})${gap}(${decimal})(?:${gap}(${unitLexeme}))?`,
  'giu',
);
const completeUnit = new RegExp(`^${unitBoundary}`, 'iu');
const sourceScalar = new RegExp(
  `${numberBoundary}(${decimal})${gap}(${unitLexeme})${unitBoundary}`,
  'giu',
);

function scaledDecimal(raw: string, scale: bigint) {
  const [, sign, whole, fraction = ''] = /^([+−-]?)(\d{1,9})(?:\.(\d{1,6}))?$/u.exec(
    raw.replace(/[,，]/gu, ''),
  )!;
  const amount = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  return (sign === '-' || sign === '−' ? -amount : amount) * scale;
}

function normalized(match: RegExpMatchArray, unit: Unit) {
  return [match[1]!, ...(match[2] ? [match[2]] : [])].map((value) =>
    scaledDecimal(value, unit.scale),
  );
}

function supportedUnit(raw: string | undefined, family: string) {
  const unit = raw ? units.get(unitKey(raw)) : undefined;
  return unit?.family === family ? unit : undefined;
}

function matchingAmounts(text: string, expected: bigint[], unit: Unit) {
  // 复合算式只交人工核对，避免把分子、分母或乘积因子当作独立证据。
  if (compoundQuantity.test(text)) return [];
  const ranges = [...text.matchAll(sourceRange)].filter((range) => {
    const [, , startUnit, separator, , endUnit] = range;
    if (
      separator?.toLowerCase() !== 'to' ||
      !startUnit ||
      !endUnit ||
      !/\b(?:add|mix|dissolve)(?:[ \t]+(?:exactly|approximately|about))?[ \t]+$/iu.test(
        text.slice(0, range.index),
      )
    )
      return true;
    const first = units.get(unitKey(startUnit));
    const last = units.get(unitKey(endUnit));
    return !first || !last || first.family === last.family;
  });
  if (expected.length === 2) {
    return ranges.filter((range) => {
      const last = supportedUnit(range[5], unit.family);
      const first = range[2] ? supportedUnit(range[2], unit.family) : last;
      return (
        first !== undefined &&
        last !== undefined &&
        completeUnit.test(text.slice(range.index + range[0].length)) &&
        scaledDecimal(range[1]!, first.scale) === expected[0] &&
        scaledDecimal(range[4]!, last.scale) === expected[1]
      );
    });
  }
  return [...text.matchAll(sourceScalar)].filter((match) => {
    const end = match.index + match[0].length;
    if (ranges.some((range) => range.index < end && range.index + range[0].length > match.index))
      return false;
    const actual = supportedUnit(match[2], unit.family);
    return actual !== undefined && scaledDecimal(match[1]!, actual.scale) === expected[0];
  });
}

function sourceSupportsClaim(pageText: string, quote: string, expected: bigint[], unit: Unit) {
  const text = normalizeWhitespace(pageText);
  const excerpt = normalizeWhitespace(quote);
  const first = text.indexOf(excerpt);
  if (!excerpt || first < 0) return false;
  // 每段空白仍占一位，与归一化后的引文位置对齐。
  const amounts = pageText
    .trim()
    .replace(/\s+/gu, (spaces: string, offset: number, page: string) => {
      if (
        /\r?\n[ \t]*\r?\n/u.test(spaces) &&
        /^[*＊][ \t]+\[[ xX]\](?:[ \t]|$)/u.test(page.slice(offset + spaces.length))
      )
        return '\f';
      return /[\r\n]/u.test(spaces) ? '\n' : ' ';
    })
    .replace(/(?<!\d)(?:\d{4}\/\d{1,2}\/\d{1,2}|\d{1,2}\/\d{1,2}\/\d{4})(?!\d)/gu, (date) =>
      ' '.repeat(date.length),
    );
  const matches = matchingAmounts(amounts, expected, unit);
  for (let offset = first; offset >= 0; offset = text.indexOf(excerpt, offset + 1)) {
    if (
      !matches.some(
        (item) => item.index >= offset && item.index + item[0].length <= offset + excerpt.length,
      )
    )
      return false;
  }
  return true;
}

export function checkQuantityClaim(
  claim: Claim,
  sourcePage: (source: Claim['sources'][number]) => string | undefined,
): 'quantity_format' | 'quantity_mismatch' | null {
  const unit = claim.unit ? units.get(unitKey(claim.unit)) : undefined;
  const match = submitted.exec(String(claim.value).trim());
  if (!unit || !match) return 'quantity_format';
  const expected = normalized(match, unit);
  const matches = (citation: Claim['sources'][number]) => {
    const text = sourcePage(citation);
    return text !== undefined && sourceSupportsClaim(text, citation.quote, expected, unit);
  };
  return claim.sources.length > 0 && claim.sources.every(matches) ? null : 'quantity_mismatch';
}
