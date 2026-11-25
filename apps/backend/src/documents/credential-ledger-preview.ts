import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../api/errors.js';

const headers = [
  '类型',
  '编号',
  '持证主体',
  '型号',
  '市场',
  '授权状态',
  '生效日',
  '到期日',
  '费用',
  '币种',
  '负责人账号',
  '来源',
] as const;
type Header = (typeof headers)[number];
const required = ['类型', '编号', '持证主体', '负责人账号'] as const;
const clean = (text: string) => text.trim().normalize('NFC');
const text = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((value) => !value.includes('\0'))
  .transform((value) => value.normalize('NFC'));
const identifier = z.uuid().transform((value) => value.toLowerCase());
const currencies = new Set(Intl.supportedValuesOf('currency'));
const currencyCode = z.string().refine((value) => currencies.has(value));
const amount = z
  .string()
  .regex(/^\d{1,10}(?:\.\d{1,2})?$/u)
  .transform((value) => {
    const [whole, fraction = ''] = value.split('.');
    const cents = fraction.replace(/0+$/u, '');
    return `${Number(whole)}${cents ? '.' + cents : ''}`;
  });
const credential = z.strictObject({
  type: text,
  number: text,
  holder: text,
  model: text.nullable(),
  market: z.enum(['US', 'CA']).nullable(),
  authorization: z.enum(['可售', '已列名']).nullable(),
  startsOn: z.iso.date().nullable(),
  expiresOn: z.iso.date().nullable(),
  fee: amount.nullable(),
  currency: currencyCode.nullable(),
  ownerId: identifier,
});
type Credential = z.infer<typeof credential>;
const references = z.strictObject({
  members: z.array(z.strictObject({ id: identifier, username: text, displayName: text })).max(300),
  existing: credential.array().max(10_000),
});
type Member = z.infer<typeof references>['members'][number];
type Row = { line: number; cells: string[] };
type PreviewBase = { line: number; source: string };
type Candidate = PreviewBase & { declaredSource: string | null; proposed: Credential };
type Invalid = PreviewBase & { status: 'error'; problems: { code: string; column?: Header }[] };
type PreviewRow =
  | Invalid
  | (Candidate & { status: 'new' | 'unchanged' })
  | (Candidate & { status: 'conflict'; current: Credential; origin: 'current' })
  | (Candidate & {
      status: 'conflict';
      current: Credential | null;
      alternative: Credential;
      origin: 'same_file';
    });

function invalid(message: string, code = 'LEDGER_PREVIEW_CSV_INVALID') {
  return new AppError(422, code, message);
}

function csvRows(content: string): Row[] {
  const result: Row[] = [];
  let line = 1;
  let firstLine = 1;
  let cells: string[] = [];
  let field = '';
  let state: 'plain' | 'quoted' | 'closed' = 'plain';
  const finishField = () => {
    if (cells.length >= 128) throw invalid('台账每行最多 128 列。');
    cells.push(field);
    field = '';
    state = 'plain';
  };
  const finishRow = () => {
    const hasFields = cells.length > 0 || state === 'closed' || Boolean(clean(field));
    finishField();
    if (hasFields) {
      if (result.length >= 10_001) throw invalid('台账每份最多 10000 行，请拆分后预览。');
      result.push({ line: firstLine, cells });
    }
    cells = [];
  };
  for (let index = 0; index < content.length; index++) {
    const character = content[index]!;
    if (state === 'quoted' && character === '"') {
      if (content[index + 1] === '"') {
        field += '"';
        index++;
      } else state = 'closed';
      continue;
    }
    if (character === '\n' || character === '\r') {
      if (character === '\r' && content[index + 1] === '\n') index++;
      if (state === 'quoted') field += '\n';
      else {
        finishRow();
        firstLine = line + 1;
      }
      line++;
    } else if (state !== 'quoted' && character === ',') finishField();
    else if (state === 'plain' && character === '"' && !field) state = 'quoted';
    else if (state === 'closed' || (state === 'plain' && character === '"'))
      throw invalid(`第 ${line} 行的 CSV 引号位置不正确。`);
    else field += character;
  }
  if (state === 'quoted') throw invalid(`第 ${firstLine} 行的 CSV 引号没有结束。`);
  if (field || cells.length || state === 'closed') finishRow();
  return result;
}

function worksheetDate(raw: string) {
  if (!raw) return null;
  const separated = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/u.exec(raw);
  if (separated) {
    const date = `${separated[1]}-${separated[3]!.padStart(2, '0')}-${separated[4]!.padStart(2, '0')}`;
    const parsed = z.iso.date().safeParse(date);
    return parsed.success ? date : undefined;
  }
  if (!/^\d{1,7}$/u.test(raw)) return undefined;
  const serial = Number(raw);
  // Excel 1900 日期系统包含一个不存在的闰日，拒绝序列号 60。
  if (serial < 1 || serial === 60 || serial > 2_958_465) return undefined;
  const days = serial < 60 ? serial : serial - 1;
  return new Date(Date.UTC(1899, 11, 31) + days * 86_400_000).toISOString().slice(0, 10);
}

const marketByLabel = new Map([
  ['US', 'US'],
  ['美国', 'US'],
  ['CA', 'CA'],
  ['加拿大', 'CA'],
] as const);
const identityKey = ({ type, number }: Pick<Credential, 'type' | 'number'>) =>
  JSON.stringify([type, number]);
const equivalent = (a: Credential, b: Credential) => JSON.stringify(a) === JSON.stringify(b);

function normalize(
  row: Row,
  header: string[],
  filename: string,
  members: Member[],
): Candidate | Invalid {
  const location = { line: row.line, source: `${filename} 第 ${row.line} 行` };
  const errors: { code: string; column?: Header }[] = [];
  const add = (code: string, column?: Header) =>
    errors.push({ code, ...(column ? { column } : {}) });
  const fail = () => ({ ...location, status: 'error' as const, problems: errors });
  if (row.cells.length !== header.length) {
    add('column_count');
    return fail();
  }
  const fields = new Map(header.map((column, index) => [column, clean(row.cells[index]!)]));
  const get = (key: Header) => fields.get(key) ?? '';
  for (const column of required) if (!get(column)) add('required', column);
  if (errors.length) return fail();
  const owner = get('负责人账号');
  const owners = new Set(
    members
      .filter(
        (member) =>
          clean(member.username).toLowerCase() === owner.toLowerCase() ||
          clean(member.displayName) === owner,
      )
      .map(({ id }) => id),
  );
  if (owners.size !== 1) add(owners.size ? 'owner_ambiguous' : 'owner_unknown', '负责人账号');
  const marketInput = get('市场');
  const market =
    [...marketByLabel].find(([label]) => label === marketInput.toUpperCase())?.[1] ?? null;
  if (marketInput && !market) add('market_unknown', '市场');
  const authorization = get('授权状态');
  if (authorization && !['可售', '已列名'].includes(authorization))
    add('authorization_unknown', '授权状态');
  if (authorization && (!market || !get('型号'))) add('authorization_link_required', '授权状态');
  const startsOn = worksheetDate(get('生效日'));
  const expiresOn = worksheetDate(get('到期日'));
  if (startsOn === undefined) add('invalid_date', '生效日');
  if (expiresOn === undefined) add('invalid_date', '到期日');
  if (startsOn && expiresOn && expiresOn < startsOn) add('date_order', '到期日');
  const fee = get('费用') || null;
  const currency = get('币种').toUpperCase() || null;
  if ((fee === null) !== (currency === null)) add('fee_currency_pair', fee ? '币种' : '费用');
  if (fee !== null && !amount.safeParse(fee).success) add('invalid_fee', '费用');
  if (currency !== null && !currencyCode.safeParse(currency).success)
    add('invalid_currency', '币种');
  if (errors.length) return fail();
  const result = credential.safeParse({
    type: get('类型'),
    number: get('编号'),
    holder: get('持证主体'),
    model: get('型号') || null,
    market,
    authorization: authorization || null,
    startsOn,
    expiresOn,
    fee,
    currency,
    ownerId: [...owners][0],
  });
  if (!result.success) {
    add('invalid_value');
    return fail();
  }
  return { ...location, declaredSource: get('来源') || null, proposed: result.data };
}

export function previewCredentialLedger(filename: string, bytes: Buffer, snapshot: unknown) {
  if (
    !/^[^\\/:\r\n]+\.csv$/iu.test(filename) ||
    filename.includes('\0') ||
    filename.length > 160 ||
    bytes.byteLength > 8 * 1024 * 1024
  )
    throw invalid('请选择不超过 8 MiB 的 CSV 台账。');
  const parsed = references.safeParse(snapshot);
  if (!parsed.success)
    throw invalid('当前成员或证照快照格式不正确。', 'LEDGER_PREVIEW_REFERENCE_INVALID');
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalid('台账需要 UTF-8 CSV 格式。');
  }
  if (content.includes('\0')) throw invalid('台账包含无效字符。');
  const [first, ...rows] = csvRows(content);
  const header = first?.cells.map(clean) ?? [];
  if (
    first?.line !== 1 ||
    new Set(header).size !== header.length ||
    headers.some((name) => !header.includes(name))
  )
    throw invalid('第一行请填写证照导入模板的全部列名，每列只出现一次。');
  const ignoredColumns = header.filter((name) => !headers.some((accepted) => accepted === name));
  const existing = new Map(parsed.data.existing.map((row) => [identityKey(row), row]));
  if (existing.size !== parsed.data.existing.length)
    throw invalid(
      '现有台账的证照键重复，请核对台账后重新预览。',
      'LEDGER_PREVIEW_REFERENCE_INVALID',
    );
  const candidates = rows.map((row) => normalize(row, header, filename, parsed.data.members));
  const firstByKey = new Map<string, Candidate>();
  const conflictByKey = new Map<string, Candidate>();
  const authorizations = new Map<string, Set<string>>();
  const marketKey = ({ model, market }: Pick<Credential, 'model' | 'market'>) =>
    JSON.stringify([model, market]);
  const addAuthorization = (row: Credential) => {
    if (!row.authorization) return;
    const key = marketKey(row);
    const sources = authorizations.get(key) ?? new Set<string>();
    sources.add(identityKey(row));
    authorizations.set(key, sources);
  };
  for (const record of existing.values()) addAuthorization(record);
  for (const candidate of candidates) {
    if (!('proposed' in candidate)) continue;
    addAuthorization(candidate.proposed);
    const key = identityKey(candidate.proposed);
    const first = firstByKey.get(key);
    if (!first) firstByKey.set(key, candidate);
    else if (!equivalent(candidate.proposed, first.proposed)) conflictByKey.set(key, candidate);
  }
  const preview: PreviewRow[] = candidates.map((candidate) => {
    if ('status' in candidate) return candidate;
    const key = identityKey(candidate.proposed);
    const current = existing.get(key) ?? null;
    const first = firstByKey.get(key)!;
    const inFile = conflictByKey.get(key);
    if (inFile)
      return {
        ...candidate,
        status: 'conflict',
        current,
        alternative: equivalent(candidate.proposed, first.proposed)
          ? inFile.proposed
          : first.proposed,
        origin: 'same_file',
      };
    if (current && equivalent(current, candidate.proposed))
      return { ...candidate, status: 'unchanged' };
    if (
      candidate.proposed.authorization &&
      (authorizations.get(marketKey(candidate.proposed))?.size ?? 0) > 1
    )
      return {
        line: candidate.line,
        source: candidate.source,
        status: 'error',
        problems: [{ code: 'authorization_duplicate', column: '授权状态' }],
      };
    if (current) return { ...candidate, status: 'conflict', current, origin: 'current' };
    return { ...candidate, status: candidate !== first ? 'unchanged' : 'new' };
  });
  return {
    format: 'credential-ledger-preview-v1',
    originalSha256: createHash('sha256').update(bytes).digest('hex'),
    ignoredColumns,
    rows: preview,
    counts: Object.fromEntries(
      (['new', 'unchanged', 'conflict', 'error'] as const).map((status) => [
        status,
        preview.filter((row) => row.status === status).length,
      ]),
    ),
  };
}
