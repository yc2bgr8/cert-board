import { z } from 'zod';
import { officialLookupInputSchema, type OfficialLookupInput } from '@cert-board/shared';
import { AppError } from '../../api/errors.js';
import { normalizeOfficialResponse, officialRequestUrl } from '../../official/providers.js';

const namedIdentity = z.string().trim().min(2).max(200);
export const replayScopeSchema = z.strictObject({
  asOf: z.iso.date(),
  brands: z.array(namedIdentity).max(12),
  applicants: z.array(namedIdentity).max(12),
  kNumbers: z.array(z.string().regex(/^K\d{6}$/u)).max(12),
  licenceNumbers: z.array(z.string().regex(/^\d{1,12}$/u)).max(12),
});
export type ReplayScope = z.infer<typeof replayScopeSchema>;

const separator = String.raw`[\p{White_Space}\u200B\u2060_–—-]*`;
const nameSeparator = String.raw`[\p{White_Space}\u200B\u2060]+`;
const wordGap = String.raw`[\p{White_Space}\u200B\u2060]*`;
const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const idCharacter = (character: string) =>
  `[${character}${String.fromCharCode(character.charCodeAt(0) + 0xfee0)}]`;
const identifiers = (scope: ReplayScope) =>
  [...scope.kNumbers, ...scope.licenceNumbers].map(
    (value) =>
      `(?<![A-Za-z0-9Ａ-Ｚａ-ｚ０-９])${[...value].map(idCharacter).join(separator)}(?![A-Za-z0-9Ａ-Ｚａ-ｚ０-９])`,
  );

export function redactReplayInput(text: string, scope: ReplayScope) {
  const names = [...scope.brands, ...scope.applicants]
    .map((name) => name.normalize('NFKC'))
    .sort((a, b) => b.length - a.length)
    .map((name) =>
      name
        .split(/[\p{White_Space}\u200B\u2060]+/u)
        .map((word) =>
          [...graphemes.segment(word)].map(({ segment }) => escape(segment)).join(wordGap),
        )
        .join(nameSeparator),
    );
  const terms = [...names, ...identifiers(scope)];
  if (!terms.length) return text;
  // 在匹配副本统一字符，替换区间以外仍返回原文供逐字引用。
  let normalized = '';
  const ranges: { start: number; end: number }[] = [];
  for (const { segment, index } of graphemes.segment(text)) {
    const transformed = segment.normalize('NFKC');
    normalized += transformed;
    const range = { start: index, end: index + segment.length };
    for (let unit = 0; unit < transformed.length; unit++) ranges.push(range);
  }
  let cursor = 0;
  let redacted = '';
  for (const matched of normalized.matchAll(new RegExp(terms.join('|'), 'giu'))) {
    const start = ranges[matched.index]!.start;
    if (start < cursor) continue;
    redacted += text.slice(cursor, start) + '[已遮挡]';
    cursor = ranges[matched.index + matched[0].length - 1]!.end;
  }
  return redacted + text.slice(cursor);
}

const licenceFields = new Set([
  'licence',
  'licenceid',
  'licenceids',
  'licencenumber',
  'licencenumbers',
  'licenceno',
  'originallicenceno',
  'license',
  'licenseid',
  'licenseids',
  'licensenumber',
  'licensenumbers',
  'licenseno',
  'originallicenseno',
  '许可号',
  '许可编号',
  '证照编号',
]);
const clearanceFields = new Set([
  'knumber',
  'knumbers',
  '510knumber',
  'clearancenumber',
  'k号',
  'k编号',
]);
const sharedIdentifierFields = new Set(['identifier', 'identifiers', 'regulatoryidentifier']);

export function isHiddenReplayNumber(value: number, scope: ReplayScope, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) return false;
  const name = field
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_-]/gu, '');
  const shared = sharedIdentifierFields.has(name);
  return (
    ((shared || licenceFields.has(name)) &&
      scope.licenceNumbers.some((number) => Number(number) === value)) ||
    ((shared || clearanceFields.has(name)) &&
      scope.kNumbers.some((number) => Number(number.slice(1)) === value))
  );
}

export function archivedOfficialReplay(
  input: OfficialLookupInput,
  scope: ReplayScope,
  archives: ReadonlyMap<string, { payload: unknown }>,
) {
  const asOf = input.asOf && input.asOf < scope.asOf ? input.asOf : scope.asOf;
  const query = officialLookupInputSchema.parse({ ...input, asOf });
  const unavailable = { status: 'unavailable' as const, reason: 'archived_source_unavailable' };
  try {
    const snapshot = archives.get(officialRequestUrl(query));
    return snapshot
      ? { status: 'ok' as const, ...normalizeOfficialResponse(query, snapshot.payload) }
      : unavailable;
  } catch (error) {
    if (error instanceof AppError && error.code === 'OFFICIAL_HISTORY_UNAVAILABLE')
      return unavailable;
    throw error;
  }
}

export function replayEvidenceValidity(
  scope: ReplayScope,
  evidence: readonly { quote: string; availableOn: string | null }[],
) {
  const terms = identifiers(scope);
  const forbidden = terms.length ? new RegExp(terms.join('|'), 'iu') : null;
  const findings = new Set<
    'target_identifier_in_evidence' | 'future_evidence' | 'source_date_unavailable'
  >();
  for (const source of evidence) {
    if (forbidden?.test(source.quote.normalize('NFKC')))
      findings.add('target_identifier_in_evidence');
    if (!source.availableOn || !z.iso.date().safeParse(source.availableOn).success)
      findings.add('source_date_unavailable');
    else if (source.availableOn > scope.asOf) findings.add('future_evidence');
  }
  return { valid: findings.size === 0, findings: [...findings].sort() };
}
