import type { StructuredSubmission } from '@cert-board/shared';

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
  ['temperature_c', 1n, ['°c', '℃', '摄氏度']],
  ['pressure_cm_water', 1n, ['cmh2o', 'cmh₂o']],
  ['voltage', 1n, ['v', 'volt', 'volts']],
  ['mass', 1n, ['g', '克']],
  ['mass', 1000n, ['kg', '千克']],
] as const;
const unitKey = (value: string) => value.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
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
const gap = '[ \\t\\u00a0\\u202f]*';
const numberBoundary = '(?<![A-Za-z0-9.+−-])(?<!\\d[,， \\u00a0\\u202f])';
const unitBoundary = '(?![A-Za-z\\p{N}/⁄^⋅·*×⁻])';
const decimal = '[+−-]?(?:\\d{1,3}(?:[,，]\\d{3}){1,2}|\\d{1,9})(?:\\.\\d{1,6})?';
const rangeSeparator = '(?:-|−|–|—|~|～|至|to\\b)';
const unitAtom = `(?:cm${gap}h[2₂]o|°${gap}[A-Za-z]|℃|${chineseUnits}|[A-Za-zµμΩ%][A-Za-z\\p{N}µμΩ]*)[\\p{N}^⁻]*`;
const unitLexeme = `${unitAtom}(?:${gap}(?:[/⁄⋅·]|per\\b)${gap}${unitAtom})*`;
const submitted = new RegExp(`^(${decimal})(?:${gap}${rangeSeparator}${gap}(${decimal}))?$`, 'iu');
const sourceRange = new RegExp(
  `${numberBoundary}(${decimal})${gap}(${unitLexeme})?${gap}${rangeSeparator}${gap}(${decimal})${gap}(${unitLexeme})?${unitBoundary}`,
  'giu',
);
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

function matchesQuote(quote: string, expected: bigint[], unit: Unit) {
  const ranges = [...quote.matchAll(sourceRange)];
  if (expected.length === 2) {
    return ranges.some((range) => {
      const last = supportedUnit(range[4], unit.family);
      const first = range[2] ? supportedUnit(range[2], unit.family) : last;
      return (
        first !== undefined &&
        last !== undefined &&
        scaledDecimal(range[1]!, first.scale) === expected[0] &&
        scaledDecimal(range[3]!, last.scale) === expected[1]
      );
    });
  }
  return [...quote.matchAll(sourceScalar)].some((match) => {
    const end = match.index + match[0].length;
    if (ranges.some((range) => range.index < end && range.index + range[0].length > match.index))
      return false;
    const actual = supportedUnit(match[2], unit.family);
    return actual !== undefined && scaledDecimal(match[1]!, actual.scale) === expected[0];
  });
}

export function checkQuantityClaim(claim: Claim): 'quantity_format' | 'quantity_mismatch' | null {
  const unit = claim.unit ? units.get(unitKey(claim.unit)) : undefined;
  const match = submitted.exec(String(claim.value).trim());
  if (!unit || !match) return 'quantity_format';
  const expected = normalized(match, unit);
  const matches = ({ quote }: Claim['sources'][number]) => matchesQuote(quote, expected, unit);
  return claim.sources.length > 0 && claim.sources.every(matches) ? null : 'quantity_mismatch';
}
