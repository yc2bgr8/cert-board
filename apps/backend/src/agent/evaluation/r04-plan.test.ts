import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parseSkillDraftMarkdown } from '../../skills/markdown.js';
import { assessR04Plan, r04ScenarioSchema } from './r04-plan.js';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const fixtures = r04ScenarioSchema
  .array()
  .length(2)
  .parse(JSON.parse(read('../../../../../fixtures/r04/scenarios.json')));
const [oral, pap] = [fixtures[0]!, fixtures[1]!];
const markdown = read('../../../../../skills/R04-适用法规标准与证据规划/SKILL.md');
const oralCategories = [
  'cytotoxicity',
  'sensitization',
  'intracutaneous_reactivity',
  'cleaning',
  'durability',
  'shelf_life',
  'material',
  'labelling',
];
const papCategories = [
  'electrical_safety',
  'emc',
  'specific_performance',
  'gas_path',
  'software',
  'cybersecurity',
  'human_factors',
  'wireless_coexistence',
];

function line(index: number, scenario: typeof oral, number = 0) {
  const { documentId, version, page, text } = scenario.pages[index]!;
  return { documentId, version, page, quote: text.split('\n')[number]! };
}

test('R04 的草稿可由现行技能登记器解析，来源为官方链接', () => {
  const skill = parseSkillDraftMarkdown(markdown);
  expect(skill.metadata).toMatchObject({
    id: 'R04',
    agentCode: 'registration',
    evaluation: 'eval:r04',
    requiredChecks: ['V1', 'V3'],
  });
  expect(skill.body).toContain('草稿，待注册人员确认');
  for (const entry of ['2‑313', '1‑199', '1‑173', '19‑49', '19‑36', '19‑48', '待提供标准原文']) {
    expect(skill.body).toContain(entry);
  }
  const hosts = [...skill.body.matchAll(/\]\((https:\/\/[^)]+)\)/gu)].map(
    (match) => new URL(match[1]!).hostname,
  );
  expect(hosts.length).toBeGreaterThanOrEqual(9);
  expect(hosts.every((host) => ['www.fda.gov', 'www.accessdata.fda.gov'].includes(host))).toBe(
    true,
  );
  expect(oral.synthetic && pap.synthetic).toBe(true);
});

const planningOnly = {
  status: 'missing',
  scope: 'not_yet_tested',
  testedModels: [],
  sampleSource: null,
  representativeBasis: null,
  criterion: null,
  result: 'pending',
};

test('E04 口内合成题逐类计分，大号报告保留小号覆盖缺口', () => {
  const triggers = [0, 0, 0, 1, 1, 2, 3, 2];
  const plan = oralCategories.map((category) => ({
    ...planningOnly,
    category,
    targetModels: ['试制大号', '试制小号'],
    productSource: line(0, oral, triggers[oralCategories.indexOf(category)]!),
    basis: {
      title: '美国口内器械特别控制指南',
      edition: '2002-11',
      url: 'https://www.fda.gov/medical-devices/guidance-documents-medical-devices-and-radiation-emitting-products/intraoral-devices-snoring-andor-obstructive-sleep-apnea-class-ii-special-controls-guidance-document',
    },
    ...(['cleaning', 'durability'].includes(category)
      ? {
          status: 'existing',
          scope: 'extension_pending',
          testedModels: ['试制大号'],
          sampleSource: line(1, oral),
        }
      : {}),
  }));
  const requirements = oralCategories.map((category, index) => ({
    category,
    productQuote: line(0, oral, triggers[index]!).quote,
    testedModels: ['cleaning', 'durability'].includes(category) ? ['试制大号'] : [],
    ...(['cleaning', 'durability'].includes(category)
      ? ({ status: 'existing', scope: 'extension_pending' } as const)
      : ({ status: 'missing', scope: 'not_yet_tested' } as const)),
  }));
  expect(assessR04Plan(plan, oral, requirements)).toEqual([]);
  expect(
    assessR04Plan(
      plan.filter(({ category }) => category !== 'sensitization'),
      oral,
      requirements,
    ),
  ).toContainEqual({ category: 'sensitization', code: 'missing_category' });
  expect(
    assessR04Plan(
      plan.map((row) =>
        row.category === 'cleaning' ? { ...row, scope: 'justified', result: 'met' } : row,
      ),
      oral,
      requirements,
    ),
  ).toEqual(
    expect.arrayContaining([
      { category: 'cleaning', code: 'unsupported_scope' },
      { category: 'cleaning', code: 'unsubstantiated_result' },
    ]),
  );
  expect(
    assessR04Plan(
      plan.map((row) =>
        row.category === 'cleaning'
          ? { ...row, testedModels: ['试制大号', '试制小号'], scope: 'tested_only' }
          : row,
      ),
      oral,
      requirements,
    ),
  ).toContainEqual({ category: 'cleaning', code: 'unexpected_assessment' });
});

test('CPAP 合成题覆盖有源类目，注入未来或写造证据时不计为有效', () => {
  const triggers = [0, 0, 1, 1, 1, 2, 0, 2];
  const plan = papCategories.map((category) => ({
    ...planningOnly,
    category,
    targetModels: ['基础版', '无线版'],
    productSource: line(0, pap, triggers[papCategories.indexOf(category)]!),
    basis: {
      title: 'FDA 睡眠呼吸治疗设备公开认可信息',
      edition: '2025-11',
      url: 'https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfstandards/detail.cfm?standard__identification_no=46594',
    },
    ...(category === 'electrical_safety'
      ? {
          status: 'existing',
          scope: 'extension_pending',
          testedModels: ['基础版'],
          sampleSource: line(1, pap),
        }
      : {}),
  }));
  const requirements = papCategories.map((category, index) => ({
    category,
    productQuote: line(0, pap, triggers[index]!).quote,
    testedModels: category === 'electrical_safety' ? ['基础版'] : [],
    ...(category === 'electrical_safety'
      ? ({ status: 'existing', scope: 'extension_pending' } as const)
      : ({ status: 'missing', scope: 'not_yet_tested' } as const)),
  }));
  expect(assessR04Plan(plan, pap, requirements)).toEqual([]);
  const future = {
    ...pap,
    pages: [pap.pages[0]!, { ...pap.pages[1]!, availableOn: '2026-12-01' }],
  };
  expect(assessR04Plan(plan, future, requirements)).toContainEqual({
    category: 'electrical_safety',
    code: 'unverifiable_quote',
  });
  expect(
    assessR04Plan(
      plan.map((row) =>
        row.category === 'electrical_safety'
          ? { ...row, testedModels: ['基础版', '无线版'], scope: 'tested_only' }
          : row,
      ),
      pap,
      requirements,
    ),
  ).toContainEqual({ category: 'electrical_safety', code: 'unverifiable_sample' });
});
