import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { officialRequestUrl } from '../../official/providers.js';
import {
  archivedOfficialReplay,
  redactReplayInput,
  replayEvidenceValidity,
  replayScopeSchema,
} from './replay.js';

const scope = replayScopeSchema.parse({
  asOf: '2018-01-01',
  brands: ['示例™ A+B'],
  applicants: ['Example (Public) Ltd.'],
  kNumbers: ['K253845'],
  licenceNumbers: ['113514'],
});

test('送给回放 Agent 的文本隐藏身份与编号，保留其他对比器械', () => {
  const input =
    '示例™ a+b 由 Example (Public) Ltd. 申报，评测目标 k 25-3845、许可 113514。另一个对比器械 K170825。';
  const redacted = redactReplayInput(input, scope);
  expect(redacted.match(/\[已遮挡\]/gu)).toHaveLength(4);
  expect(redacted).toContain('K170825');
  expect(redacted).not.toContain('113514');
  expect(redactReplayInput('申请人 Example\n(Public)\u00a0Ltd. 的品牌是示例™\nA+B。', scope)).toBe(
    '申请人 [已遮挡] 的品牌是[已遮挡]。',
  );
  expect(redactReplayInput('编号Ｋ２５３８４５和许可113514已经删去。', scope)).toBe(
    '编号[已遮挡]和许可[已遮挡]已经删去。',
  );
  expect(redactReplayInput('目标编号 K25\n3845 和许可号 113\u00a0514', scope)).toBe(
    '目标编号 [已遮挡] 和许可号 [已遮挡]',
  );
});

const snapshot = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../../../fixtures/official/${name}.json`, import.meta.url), 'utf8'),
  );

test('词内断行和组合重音可识别目标，其他原文字节保留', () => {
  const names = { ...scope, brands: ['星河医疗', 'Café'], applicants: ['Example Ltd.'] };
  expect(redactReplayInput('星河\n医疗和 Exam\nple Ltd. 使用 Cafe\u0301 品牌。', names)).toBe(
    '[已遮挡]和 [已遮挡] 使用 [已遮挡] 品牌。',
  );
  expect(redactReplayInput('引语 Cafe\u0301。', scope)).toBe('引语 Cafe\u0301。');
  expect(redactReplayInput('申请人 Ｅｘａｍｐｌｅ Ｌｔｄ．，其他原文 Ａ。', names)).toBe(
    '申请人 [已遮挡]，其他原文 Ａ。',
  );
});

test('官方回放沿用真实数据归一逻辑，截断未来记录且缺档无法走实时网络', () => {
  const confirmed = { dataset: 'fda_510k', kNumber: 'K170825' } as const;
  const later = { dataset: 'fda_510k', kNumber: 'K253845' } as const;
  const archives = new Map([
    [officialRequestUrl({ ...confirmed, asOf: scope.asOf }), { payload: snapshot('fda-k170825') }],
    [officialRequestUrl({ ...later, asOf: scope.asOf }), { payload: snapshot('fda-k253845') }],
  ]);
  expect(
    archivedOfficialReplay({ ...confirmed, asOf: '2027-01-01' }, scope, archives),
  ).toMatchObject({ status: 'ok', records: [{ identifier: 'K170825' }] });
  expect(archivedOfficialReplay(later, scope, archives)).toMatchObject({
    status: 'ok',
    records: [],
  });
  expect(archivedOfficialReplay(confirmed, scope, new Map())).toMatchObject({
    status: 'unavailable',
  });
  expect(
    archivedOfficialReplay({ dataset: 'fda_classification', productCode: 'LRK' }, scope, archives),
  ).toMatchObject({ status: 'unavailable' });
});

test('证据泄漏目标编号或引用未来资料时作废，并保存固定原因', () => {
  expect(
    replayEvidenceValidity(scope, [
      { quote: '同类器械 K170825 的引用。', availableOn: '2017-12-01' },
    ]),
  ).toEqual({ valid: true, findings: [] });
  expect(
    replayEvidenceValidity(scope, [
      { quote: '目标编号 k25-3845。', availableOn: '2020-01-01' },
      { quote: '目标许可号 113514。', availableOn: null },
    ]),
  ).toEqual({
    valid: false,
    findings: ['future_evidence', 'source_date_unavailable', 'target_identifier_in_evidence'],
  });
});
