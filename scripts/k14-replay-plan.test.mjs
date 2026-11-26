import { expect, test } from 'vitest';
import { buildReplayInventory } from './k14-replay-plan.mjs';

const a = [
  { id: 'K259994', productCode: 'LRK', availableOn: '2025-12-31', cohort: 'earlier' },
  { id: 'K269995', productCode: 'LRK', availableOn: '2026-03-01', cohort: 'candidate-2026' },
  { id: 'K269996', productCode: 'LRK', availableOn: '2026-03-18', cohort: 'candidate-2026' },
  { id: 'K253845', productCode: 'LRK', availableOn: '2026-03-03', cohort: 'candidate-2026' },
];
const receipt = new Map([
  ['K269995', '2026-01-31'], ['K269996', '2026-03-01'], ['K253845', '2025-11-17'],
]);
const parsed = { file: 'K269996.pages.json', pageCount: 4, blankPages: 0 };
const pages = new Map([['K269996', parsed], ['K253845', parsed]]);
const c = {
  licences: [{ id: 99999, availableOn: '2026-06-01', riskClass: 2, type: 'D', cohort: 'candidate-2026' }],
  devices: [{ licenceId: 99999 }, { licenceId: 99998 }],
  identifiers: [{ licenceId: 99999 }, { licenceId: 99999 }, { licenceId: 99998 }],
};

test('用受理日前一日限制 FDA 可见证据，预留开发重叠项并保留缺失原件', () => {
  const plan = buildReplayInventory(a, c, receipt, pages);
  expect(plan.status).toBe('review-only');
  expect(plan.us).toHaveLength(3);
  expect(plan.us[1]).toMatchObject({
    knowledgeThrough: '2026-02-28', priorSameCodeCount: 1, summaryPages: parsed,
    afterTrainingCutoff: null, disposition: 'pending_question_review',
  });
  expect(plan.us[0]).toMatchObject({ disposition: 'missing_parsed_source', summaryPages: null });
  expect(plan.us[2].disposition).toBe('reserved_development_overlap');
});

test('按严格晚于训练截止日逐模型比较，并标明加拿大语境和回放基准缺口', () => {
  const model = { id: 'fixture/model', trainingCutoff: '2026-03-01' };
  const plan = buildReplayInventory(a, c, receipt, pages, model);
  expect(plan.model).toEqual(model);
  expect(plan.us.map(({ afterTrainingCutoff }) => afterTrainingCutoff)).toEqual([false, true, true]);
  expect(plan.canada).toEqual([{
    id: 99999, issuedOn: '2026-06-01', riskClass: 2, licenceType: 'D',
    afterTrainingCutoff: true, disposition: 'missing_reviewed_description_and_replay_date',
    devices: 1, identifiers: 2,
  }]);
  expect(plan.status).toBe('review-only');
  const companyCase = { ...c.licences[0], companyId: 184937 };
  expect(buildReplayInventory(a, { ...c, licences: [companyCase] }, receipt, pages)
    .canada[0].disposition).toBe('reserved_development_overlap');
});

test('工具拒绝无效截止日和受理日期', () => {
  expect(() => buildReplayInventory(a, c, receipt, pages, {
    id: 'fixture/model', trainingCutoff: '2026-02-30',
  })).toThrow('训练截止');
  expect(() => buildReplayInventory(a, c, new Map(), pages)).toThrow('受理日期');
  expect(() => buildReplayInventory(a, c, new Map([
    ...receipt, ['K269995', '2026-11-25'],
  ]), pages)).toThrow('受理日期');
});
