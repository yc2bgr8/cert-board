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
const unitKey = (value: string) => value.normalize('NFKC').trim().toLowerCase();
const units = new Map<string, Unit>(
  definitions.flatMap(([family, scale, labels]) =>
    labels.map((label) => [unitKey(label), { family, scale }] as const),
  ),
);
const unitText = definitions
  .flatMap(([, , labels]) => labels)
  .sort((a, b) => b.length - a.length)
  .join('|');
const decimal = '[+−-]?\\d{1,9}(?:\\.\\d{1,6})?';
const values = `(${decimal})(?:[ \\t]*(?:-|–|—|~|～|至|to)[ \\t]*(${decimal}))?`;
const submitted = new RegExp(`^${values}$`, 'iu');
const sourceQuantity = new RegExp(
  `(?<![A-Za-z0-9.+−-])${values}[ \\t]*(${unitText})(?![A-Za-z0-9])`,
  'giu',
);

function scaledDecimal(raw: string, scale: bigint) {
  const [, sign, whole, fraction = ''] = /^([+−-]?)(\d{1,9})(?:\.(\d{1,6}))?$/u.exec(raw)!;
  const amount = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  return (sign === '-' || sign === '−' ? -amount : amount) * scale;
}

function normalized(match: RegExpMatchArray, unit: Unit) {
  return [match[1]!, ...(match[2] ? [match[2]] : [])].map((value) =>
    scaledDecimal(value, unit.scale),
  );
}

export function checkQuantityClaim(claim: Claim): 'quantity_format' | 'quantity_mismatch' | null {
  const unit = claim.unit ? units.get(unitKey(claim.unit)) : undefined;
  const match = submitted.exec(String(claim.value).trim());
  if (!unit || !match) return 'quantity_format';
  const expected = normalized(match, unit);
  const matches = ({ quote }: Claim['sources'][number]) =>
    [...quote.matchAll(sourceQuantity)].some((raw) => {
      const sourceUnit = units.get(unitKey(raw[3]!));
      if (sourceUnit?.family !== unit.family) return false;
      const actual = normalized(raw, sourceUnit);
      return (
        actual.length === expected.length &&
        actual.every((value, index) => value === expected[index])
      );
    });
  return claim.sources.length > 0 && claim.sources.every(matches) ? null : 'quantity_mismatch';
}
