import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { readT1Fixture } from '../../documents/t1-seed.js';
import {
  ruleDefinitions,
  runConsistencyRules,
  type RuleDocument,
  type RuleId,
} from '../../rules/engine.js';

const xfa = new URL('../../../../../fixtures/l08/t1_out/estar_datasets.xml', import.meta.url);

async function fixtureDocuments() {
  const fixture = await readT1Fixture();
  return fixture.documents.map((doc): RuleDocument => ({
    key: doc.id,
    name: doc.name,
    duplicate: Boolean(doc.duplicate_of),
    ...(doc.parent ? { attachmentOf: doc.parent } : {}),
    ...(doc.id === 'D014' ? { isEstar: true, referencesText: readFileSync(xfa, 'utf8') } : {}),
    pages: fixture.pages
      .filter((p) => p.doc === doc.id)
      .map((p) => ({ page: p.page, text: p.text })),
  }));
}

test('L08 八规则候选层以 RV-05 人工标注单列 1 条误报和 2 条新增发现', async () => {
  const data = await fixtureDocuments();
  const candidates = runConsistencyRules(data, new Set(Object.keys(ruleDefinitions) as RuleId[]));
  const falsePositives = candidates.filter(
    (item) => item.ruleId === 'R3' && item.title === '储存温度在不同文件中取值不同',
  );
  const additional = candidates.filter(
    (item) =>
      item.ruleId === 'R0' && /Device Picture|Shelf-life verification report/u.test(item.title),
  );
  expect({
    total: candidates.length,
    falsePositives: falsePositives.length,
    additional: additional.length,
  }).toEqual({ total: 13, falsePositives: 1, additional: 2 });
});

test('L08 隔离副本的三处植入差异都能回到被修改的实际来源', async () => {
  const original = await fixtureDocuments();
  const copy = structuredClone(original);
  const defects = [
    { key: 'D035', page: 5, from: 'K170285', to: 'K170286', value: 'K170286', ruleId: 'R1' },
    { key: 'D021', page: 29, from: '20-25 °C', to: '21-26 °C', value: '21-26℃', ruleId: 'R3' },
    {
      key: 'D019',
      page: 1,
      from: 'Official contact person: Ms. Emma Chen',
      to: 'Official contact person: Ms. Alice Green',
      value: 'Alice Green',
      ruleId: 'R2',
    },
  ] as const;
  for (const { key, page, from, to } of defects) {
    const target = copy.find((doc) => doc.key === key)?.pages.find((item) => item.page === page);
    expect(target?.text).toContain(from);
    target!.text = target!.text.replace(from, to);
  }
  const results = runConsistencyRules(copy, new Set(['R1', 'R2', 'R3']));
  for (const { ruleId, key, page, value, from } of defects) {
    expect(
      results.some(
        (result) =>
          result.ruleId === ruleId &&
          result.values.some((item) => item.value === value) &&
          result.references.some((ref) => ref.key === key && ref.page === page),
      ),
    ).toBe(true);
    expect(
      original.find((doc) => doc.key === key)?.pages.find((item) => item.page === page)?.text,
    ).toContain(from);
  }
});
