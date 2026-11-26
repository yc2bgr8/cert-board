import { expect, test } from 'vitest';
import { buildR01Drafts, durationSummary } from './k14-r01-draft.mjs';

const candidate = {
  id: 'K269999', productCode: 'BZD', receivedOn: '2026-03-01', knowledgeThrough: '2026-02-28',
  decisionOn: '2026-05-01', disposition: 'pending_question_review',
};
const records = [
  { id: candidate.id, productCode: 'BZD', availableOn: '2026-05-01' },
  { id: 'K259990', productCode: 'BZD', availableOn: '2025-12-21' },
  { id: 'K269991', productCode: 'BZD', availableOn: '2026-02-28' },
  { id: 'K269992', productCode: 'BZD', availableOn: '2026-03-01' },
  { id: 'K269993', productCode: 'LRK', availableOn: '2026-01-01' },
];
const received = new Map([
  [candidate.id, '2026-03-01'], ['K259990', '2025-12-01'], ['K269991', '2026-01-01'],
]);

test('近秩法给出离散自然日的四分位数，允许同日决定', () => {
  expect(durationSummary([58, 0, 20, 64])).toEqual({ samples: 4, p25: 0, p50: 20, p75: 58 });
  expect(durationSummary([12])).toEqual({ samples: 1, p25: 12, p50: 12, p75: 12 });
  expect(() => durationSummary([12, -1])).toThrow('历时');
});

test('只显示受理日前公开的同代码历史历时，目标决定与申报编号留给审阅', () => {
  const result = buildR01Drafts([candidate], records, received);
  expect(result.questions[0]).toMatchObject({ id: 'R01-A01', productCode: 'BZD', startOn: '2026-03-01' });
  expect(result.evidence).toEqual([{ id: 'R01-A01', durationsDays: [20, 58] }]);
  expect(JSON.stringify([result.questions, result.evidence])).not.toMatch(/K\d{6}|2026-05-01/u);
  expect(result.answers[0]).toMatchObject({
    clearanceId: candidate.id, sampleClearanceIds: ['K259990', 'K269991'],
    expected: {
      samples: 2, p25: 20, p50: 20, p75: 58,
      plannedDecisionDates: { p25: '2026-03-21', p50: '2026-03-21', p75: '2026-04-28' },
    },
    observed: { decisionOn: '2026-05-01', elapsedDays: 61 },
  });
});

test('同日证据截止、样本受理日期缺失都会拒绝，没往例时显式记录排除', () => {
  expect(() => buildR01Drafts([{ ...candidate, knowledgeThrough: candidate.receivedOn }], records, received))
    .toThrow('受理日前一日');
  expect(() => buildR01Drafts([candidate], records, new Map([[candidate.id, candidate.receivedOn]])))
    .toThrow('日期无效');
  expect(buildR01Drafts([candidate], [records[0]], received)).toEqual({
    questions: [], evidence: [], answers: [],
    excluded: [{ clearanceId: candidate.id, reason: 'no_prior_same_code_records' }],
  });
  expect(buildR01Drafts([{ ...candidate, disposition: 'reserved_development_overlap' }], records, received).questions)
    .toEqual([]);
});
