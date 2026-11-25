import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { previewCredentialLedger } from './credential-ledger-preview.js';
import { parseSkillDraftMarkdown } from '../skills/markdown.js';

const root = new URL('../../../../fixtures/credential-ledger/', import.meta.url);
const csv = readFileSync(new URL('synthetic.csv', root));
const snapshot = JSON.parse(readFileSync(new URL('synthetic-context.json', root), 'utf8'));
const header = csv.toString('utf8').split('\n')[0]!;
const preview = (rows: string[], state: unknown = snapshot) =>
  previewCredentialLedger('synthetic.csv', Buffer.from([header, ...rows].join('\r\n')), state);

test('按合同/证照键清洗预览，原字节哈希与实际行号可追溯', () => {
  const result = previewCredentialLedger('synthetic.csv', csv, snapshot);
  expect(result.originalSha256).toBe(createHash('sha256').update(csv).digest('hex'));
  expect(result.ignoredColumns).toEqual(['备注']);
  expect(result.counts).toEqual({ new: 1, unchanged: 1, conflict: 1, error: 1 });
  expect(result.rows).toEqual([
    expect.objectContaining({
      line: 2,
      status: 'unchanged',
      proposed: expect.objectContaining({ currency: 'USD', fee: '152' }),
    }),
    expect.objectContaining({
      line: 3,
      status: 'conflict',
      origin: 'current',
      current: expect.objectContaining({ expiresOn: '2027-06-30' }),
      proposed: expect.objectContaining({ expiresOn: '2027-07-01' }),
    }),
    expect.objectContaining({
      line: 4,
      source: 'synthetic.csv 第 4 行',
      status: 'new',
      declaredSource: '合成资料, 核对页',
      proposed: expect.objectContaining({
        market: 'US',
        model: 'SYNTH-MODEL',
        startsOn: '2026-01-01',
      }),
    }),
    expect.objectContaining({
      line: 5,
      status: 'error',
      problems: expect.arrayContaining([
        { code: 'invalid_date', column: '生效日' },
        { code: 'authorization_link_required', column: '授权状态' },
        { code: 'owner_unknown', column: '负责人账号' },
      ]),
    }),
  ]);
});

test('同一文件的相同记录合并，差异记录不推定覆盖，含换行的来源保留物理起行', () => {
  const row = '合同,SYNTH-ONE,甲,,,,2027-3-3,,,,synth_owner,"合成说明\r\n第二行",';
  const equal = preview([row, row]);
  expect(equal.rows.map(({ line, status }) => [line, status])).toEqual([
    [2, 'new'],
    [4, 'unchanged'],
  ]);
  expect(equal.rows[0]).toMatchObject({ declaredSource: '合成说明\n第二行' });
  const changed = preview([row, row.replace(',甲,', ',乙,')]);
  expect(changed.rows).toEqual([
    expect.objectContaining({ origin: 'same_file', status: 'conflict' }),
    expect.objectContaining({ origin: 'same_file', status: 'conflict' }),
  ]);
});

test('不同证照的相同型号市场授权冲突，负责人同名与不可用日期一并标出', () => {
  const first = '证照,SYNTH-1,甲,SYNTH-US,US,已列名,,,,,synth_owner,合成,';
  const next = first.replace('SYNTH-1', 'SYNTH-2');
  const row = '合同,SYNTH-ONE,甲,,,,60,2027/1/1,5,,合成负责人,合成,';
  const state = {
    ...snapshot,
    members: [
      snapshot.members[0],
      {
        ...snapshot.members[0],
        username: 'synth_second',
        id: '43000000-0000-4000-8000-000000000002',
      },
    ],
  };
  const result = preview([first, next, row], state);
  expect(result.rows.slice(0, 2)).toMatchObject([
    { status: 'error', problems: [{ code: 'authorization_duplicate', column: '授权状态' }] },
    { status: 'error', problems: [{ code: 'authorization_duplicate', column: '授权状态' }] },
  ]);
  expect(result.rows.at(-1)).toMatchObject({
    status: 'error',
    problems: expect.arrayContaining([
      { code: 'invalid_date', column: '生效日' },
      { code: 'owner_ambiguous', column: '负责人账号' },
      { code: 'fee_currency_pair', column: '币种' },
    ]),
  });
});

test('错列表头、无效 UTF-8、未闭合引号和重复的基线证照都中止', () => {
  expect(() =>
    previewCredentialLedger('sheet.csv', Buffer.from(header.replace('编号', '类型')), snapshot),
  ).toThrow('列名');
  expect(() => previewCredentialLedger('sheet.csv', Buffer.from([0xff]), snapshot)).toThrow(
    'UTF-8',
  );
  expect(() => preview(['"未闭合'])).toThrow('引号没有结束');
  expect(() =>
    preview([], { ...snapshot, existing: [snapshot.existing[0], snapshot.existing[0]] }),
  ).toThrow('证照键重复');
});

test('M01 草稿按维护 Agent 的实际登记格式保存', () => {
  const source = readFileSync(
    new URL('../../../../skills/M01-产品合规主数据与证照台账/SKILL.md', import.meta.url),
    'utf8',
  );
  const draft = parseSkillDraftMarkdown(source);
  expect(draft.metadata).toMatchObject({
    id: 'M01',
    agentCode: 'maintenance',
    requiredChecks: ['V1', 'V3'],
    evaluation: 'test:ledger-preview',
  });
  expect(draft.body).toContain('现有字段默认保留');
});

test('同文件冲突同时保留真实台账值和另一个候选', () => {
  const rows = [
    '代理合同,SYNTH-KEEP,合成机构乙,,,,2027-01-01,2027-06-30,152,USD,synth_owner,合成,',
    '代理合同,SYNTH-KEEP,合成机构丙,,,,2027-01-01,2027-06-30,152,USD,synth_owner,合成,',
  ];
  expect(preview(rows).rows).toMatchObject([
    {
      status: 'conflict',
      origin: 'same_file',
      current: { holder: '合成机构' },
      alternative: { holder: '合成机构丙' },
    },
    {
      status: 'conflict',
      origin: 'same_file',
      current: { holder: '合成机构' },
      alternative: { holder: '合成机构乙' },
    },
  ]);
});

test('新增授权碰撞时保留台账的相同行，未知币种与错列空行也纳入检查', () => {
  const first = '证照,SYNTH-EXISTING,合成机构,SYNTH-BASE,US,已列名,,,,,synth_owner,合成,';
  const next = first.replace('SYNTH-EXISTING', 'SYNTH-NEW');
  const currency = '证照,SYNTH-CURRENCY,合成机构,,,,,,2,ABC,synth_owner,合成,';
  const state = {
    ...snapshot,
    existing: [
      {
        ...snapshot.existing[0],
        type: '证照',
        number: 'SYNTH-EXISTING',
        market: 'US',
        model: 'SYNTH-BASE',
        authorization: '已列名',
        startsOn: null,
        expiresOn: null,
        fee: null,
        currency: null,
      },
    ],
  };
  expect(preview([first, next, currency, '', ',,'], state).rows).toMatchObject([
    { status: 'unchanged', line: 2 },
    {
      status: 'error',
      line: 3,
      problems: [{ code: 'authorization_duplicate', column: '授权状态' }],
    },
    { status: 'error', line: 4, problems: [{ code: 'invalid_currency', column: '币种' }] },
    { status: 'error', line: 6, problems: [{ code: 'column_count' }] },
  ]);
});
