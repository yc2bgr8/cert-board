import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { ruleDefinitions, runConsistencyRules, type RuleDocument, type RuleId } from './engine.js';

const directory = new URL('../../../../fixtures/l08/', import.meta.url);
const text = (name: string) => readFileSync(new URL(name, directory), 'utf8');

test('RV-05 回放使用实际 T1 资料、附件清单和 eSTAR 数据集', () => {
  const manifest = JSON.parse(text('t1_out/documents.json')) as {
    id: string;
    name: string;
    parent: string | null;
    duplicate_of: string | null;
  }[];
  const pages = text('t1_out/pages.jsonl')
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as { doc: string; page: number; text: string });
  const documents: RuleDocument[] = manifest.map((source) => ({
    key: source.id,
    name: source.name,
    duplicate: Boolean(source.duplicate_of),
    isEstar: source.id === 'D014',
    ...(source.parent ? { attachmentOf: source.parent } : {}),
    ...(source.id === 'D014' ? { referencesText: text('t1_out/estar_datasets.xml') } : {}),
    pages: pages
      .filter((page) => page.doc === source.id)
      .map(({ page, text: content }) => ({ page, text: content })),
  }));
  const baseline = JSON.parse(text('rv05/rv05_findings.json')) as {
    findings: { rule: RuleId; title: string; gt: string | null }[];
  };
  const ruleIds = new Set(Object.keys(ruleDefinitions) as RuleId[]);
  const results = runConsistencyRules(documents, ruleIds);
  const fingerprint = ({ ruleId, title }: { ruleId: RuleId; title: string }) =>
    `${ruleId}:${title}`;
  const labelCoverage = (actual: typeof results) => {
    const keys = new Set(actual.map(fingerprint));
    return [
      ...new Set(
        baseline.findings
          .filter(
            (item) => item.gt && keys.has(fingerprint({ ruleId: item.rule, title: item.title })),
          )
          .map(({ gt }) => gt),
      ),
    ].sort();
  };
  expect(labelCoverage(results)).toEqual(['GT1', 'GT2', 'GT3', 'GT4', 'GT5', 'GT6', 'GT8']);
  expect(results.map(fingerprint).sort()).toEqual(
    baseline.findings.map((item) => fingerprint({ ruleId: item.rule, title: item.title })).sort(),
  );
  expect(results.find((entry) => entry.ruleId === 'R7')?.status).toBe('human_review');
  expect(results.find((entry) => entry.ruleId === 'R5')?.values).toEqual(
    expect.arrayContaining([expect.objectContaining({ value: expect.stringMatching(/MSDS/iu) })]),
  );
});

test('同单位换算后相等的参数归为同一值，差异给出原资料定位', () => {
  const document = (key: string, content: string): RuleDocument => ({
    key,
    name: `${key}.pdf`,
    pages: [{ page: 2, text: content }],
  });
  const sources = [
    document('A', 'Soaking time: 1 hour\nProduct dimensions: 1 × 2 cm\nService life: 1 year'),
    document('B', '浸泡时间：60 分钟\n产品尺寸：10 × 20 mm\n使用期限：12 个月'),
  ];
  expect(runConsistencyRules(sources, new Set(['R3']))).toEqual([]);
  sources.push(document('C', '浸泡时间：45 分钟'));
  expect(runConsistencyRules(sources, new Set(['R3']))).toMatchObject([
    {
      title: '浸泡时间在不同文件中取值不同',
      values: [
        { value: '60 分钟', count: 2 },
        { value: '45 分钟', count: 1 },
      ],
      references: [
        { key: 'A', page: 2 },
        { key: 'B', page: 2 },
        { key: 'C', page: 2 },
      ],
    },
  ]);
});

test('R1 按完整 K 号归并写法，带点分后缀的文本不计入正常编号', () => {
  const result = runConsistencyRules(
    [
      { key: 'A', name: 'A.pdf', pages: [{ page: 1, text: '1.k170825\nK170825.1' }] },
      { key: 'B', name: 'B.pdf', pages: [{ page: 1, text: 'K170285' }] },
    ],
    new Set(['R1']),
  );
  expect(result).toMatchObject([
    {
      values: [
        { value: 'K170285', count: 1 },
        { value: 'K170825', count: 1 },
      ],
    },
  ]);
});

test('R2 只有实际跨文件的字段差异才作为候选', () => {
  const first: RuleDocument = {
    key: 'A',
    name: 'A.pdf',
    pages: [{ page: 1, text: 'Contact person: Alice Green\nSubmitter: Bob Green' }],
  };
  expect(runConsistencyRules([first], new Set(['R2']))).toEqual([]);
  expect(
    runConsistencyRules(
      [
        first,
        { key: 'B', name: 'B.pdf', pages: [{ page: 1, text: 'Contact person: Bob Green' }] },
      ],
      new Set(['R2']),
    ),
  ).toHaveLength(1);
  expect(
    runConsistencyRules(
      [
        document('A', 'Contact person:\tDr.Alice Green'),
        document('B', 'Official contact person:\nDr. Alice Green Email: alice@example.test'),
      ],
      new Set(['R2']),
    ),
  ).toEqual([]);
  expect(
    runConsistencyRules(
      [
        document('A', 'Contact person:\tAlice Green'),
        document('B', 'Official contact person:\nBob Green Email: bob@example.test'),
      ],
      new Set(['R2']),
    ),
  ).toHaveLength(1);
});

const document = (key: string, content: string, name = `${key}.pdf`): RuleDocument => ({
  key,
  name,
  pages: [{ page: 1, text: content }],
});

test('R0 同名组的第三份也比较，并给出其在原件中的位置', () => {
  const results = runConsistencyRules(
    [
      document('A', '相同内容', '封面.pdf'),
      document('B', '相同内容', '封面.pdf'),
      document('C', '修订内容', '封面.pdf'),
    ],
    new Set(['R0']),
  );
  expect(results).toMatchObject([
    {
      ruleId: 'R0',
      references: [
        { key: 'A', page: 1 },
        { key: 'C', page: 1 },
      ],
    },
  ]);
});

test('R2 保留多词姓名并忽略空白申请人字段', () => {
  const results = runConsistencyRules(
    [
      document('A', 'Contact person: Alice Mary Chen\nApplicant:     '),
      document('B', 'Contact person: Alice Mary Tan\nApplicant: Example Co'),
    ],
    new Set(['R2']),
  );
  expect(results).toMatchObject([
    {
      values: [
        { value: 'Alice Mary Chen', count: 1 },
        { value: 'Alice Mary Tan', count: 1 },
      ],
    },
  ]);
  expect(
    runConsistencyRules(
      [
        document('A', 'Contact person:\nOfficial contact person: Alice Green'),
        document('B', 'Official contact person: Alice Green'),
      ],
      new Set(['R2']),
    ),
  ).toEqual([]);
  expect(
    runConsistencyRules(
      [
        document('A', 'Contact person:\nAlice Mary Chen'),
        document('B', 'Contact person: Alice Mary Tan'),
      ],
      new Set(['R2']),
    ),
  ).toHaveLength(1);
});

test('R3 保留温度正负号并在引用限额前识别跨文档差异', () => {
  const results = runConsistencyRules(
    [
      document(
        'A',
        'Storage: -5 to 25°C\nStorage: −10 to -5°C\nSoaking time: 1 hour\nSoaking time: 1 hour\nSoaking time: 1 hour\nSoaking time: 45 min',
      ),
      document('B', 'Storage: 5 to 25°C\nSoaking time: 60 min'),
    ],
    new Set(['R3']),
  );
  expect(results.find(({ title }) => title.startsWith('储存温度'))?.values).toEqual([
    { value: '-5-25℃', count: 1 },
    { value: '-10--5℃', count: 1 },
    { value: '5-25℃', count: 1 },
  ]);
  expect(results.find(({ title }) => title.startsWith('浸泡时间'))?.references).toEqual([
    { key: 'A', page: 1 },
    { key: 'B', page: 1 },
  ]);
});

test('R4 接受单型号配置表并发现下托颜色差异', () => {
  const results = runConsistencyRules(
    [
      document('A', 'Model L08-TB\nupper tray White\nlower tray Blue'),
      document('B', 'Model L08-TB\nupper tray White\nlower tray Purple'),
    ],
    new Set(['R4']),
  );
  expect(results).toMatchObject([
    {
      title: 'L08-TB 下托颜色说法不一致',
      values: [
        { value: 'blue', count: 1 },
        { value: 'purple', count: 1 },
      ],
    },
  ]);
  expect(
    runConsistencyRules(
      [
        document('A', 'Model L08-TB\nupper tray White\nlower tray Blue'),
        document('B', 'Model L08-TB-2\nupper tray White\nlower tray Purple'),
      ],
      new Set(['R4']),
    ),
  ).toEqual([]);
  expect(
    runConsistencyRules(
      [
        document('A', 'Model L08-TB|\nupper tray White|\nlower tray Blue|'),
        document('B', 'Model L08-TB|\nupper tray White|\nlower tray Purple|'),
      ],
      new Set(['R4']),
    ),
  ).toHaveLength(1);
});

test('R5 以 XFA 字段为界，不用相邻字段的附件名掩盖未匹配引用', () => {
  const results = runConsistencyRules(
    [
      {
        ...document('A', 'eSTAR 可读原件示例'),
        isEstar: true,
        attachmentNames: ['Instructions.pdf'],
        referencesText: '<a>please see:\n<b>MSDS</b></a><b1>Instructions.pdf</b1>',
      },
    ],
    new Set(['R5']),
  );
  expect(results).toMatchObject([{ ruleId: 'R5', values: [{ value: 'MSDS' }] }]);
  expect(
    runConsistencyRules(
      [
        {
          ...document('A', 'eSTAR 示例'),
          isEstar: true,
          attachmentNames: [],
          referencesText: '<reference>Please see:\nPlease see: MSDS.pdf</reference>',
        },
      ],
      new Set(['R5']),
    ),
  ).toMatchObject([{ values: [{ value: 'MSDS.pdf' }] }]);
});
