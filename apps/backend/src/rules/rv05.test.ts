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
