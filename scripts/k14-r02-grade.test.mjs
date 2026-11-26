import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { gradeR02Run } from './k14-r02-grade.mjs';

const tuple = { deviceClass: 'II', productCode: 'BZD', regulationNumber: '868.5905', pathway: '510(k)' };
const row = (number) => ({ id: 'R02-A0' + number, expected: tuple });
const answer = (number, response = tuple) => ({ id: row(number).id, response });
const valid = (number) => ({ id: row(number).id, verdict: { valid: true, findings: [] } });
const bytes = (data) => Buffer.from(JSON.stringify(data));
const hash = (data) => createHash('sha256').update(data).digest('hex');

function inputs(keys, submitted, verdicts) {
  const key = bytes({ version: 1, status: 'review-only', cases: keys });
  const responses = bytes({ version: 1, cases: submitted });
  const replay = bytes({
    version: 1, answerKeySha256: hash(key), responsesSha256: hash(responses), cases: verdicts,
  });
  return [key, responses, replay];
}

test('字段按标准写法比对，区分错误和漏答', () => {
  const result = gradeR02Run(...inputs([row(1), row(2)], [
    answer(1, { deviceClass: '第Ⅱ类', productCode: ' bzd ', regulationNumber: '21 CFR § 868.5905',
      pathway: 'Traditional 510（Ｋ）', reasoning: '据结构和用途判断。' }),
    answer(2, { deviceClass: 2, productCode: 'BZD', pathway: 'PMA' }),
  ], [valid(1), valid(2)]));
  expect(result.cases[0]).toMatchObject({ status: 'scored', correctFields: 4 });
  expect(result.cases[1]).toMatchObject({
    status: 'scored', correctFields: 2, fields: {
      deviceClass: 'correct', productCode: 'correct', regulationNumber: 'missing', pathway: 'incorrect',
    },
  });
  expect(result.summary).toMatchObject({ totalCases: 2, fullyCorrectCases: 1, correctFields: 6, scoredFields: 8 });
});

test('无效回放、未核验作答和未作答分别统计，均不进入评分分母', () => {
  const result = gradeR02Run(...inputs([row(1), row(2), row(3), row(4)], [answer(1), answer(2), answer(3)], [
    valid(1), { id: row(2).id, verdict: {
      valid: false, findings: ['future_evidence', 'target_identifier_in_evidence'],
    } },
  ]));
  expect(result.cases.map(({ status }) => status)).toEqual([
    'scored', 'invalid_replay', 'unverified_replay', 'missing_response',
  ]);
  expect(result.cases[1]).not.toHaveProperty('correctFields');
  expect(result.summary).toMatchObject({ totalCases: 4, fullyCorrectCases: 1, correctFields: 4, scoredFields: 4 });
});

test('摘要不符时拒绝沿用旧回放核验，标准答案只接受待审且格式完整的文件', () => {
  const [key, responses, replay] = inputs([row(1)], [answer(1)], [valid(1)]);
  expect(() => gradeR02Run(key, Buffer.concat([responses, Buffer.from('\n')]), replay)).toThrow('摘要不符');
  expect(() => gradeR02Run(...inputs([{ ...row(1), expected: { ...tuple, productCode: ['BZD'] } }],
    [answer(1)], [valid(1)]))).toThrow('参考答案');
});

test('拒绝模型自报回放通过、无作答却回放通过以及不一致的核验结论', () => {
  expect(() => gradeR02Run(...inputs([row(1)], [answer(1, { ...tuple, replayValid: true })], [])))
    .toThrow('未登记');
  expect(() => gradeR02Run(...inputs([row(1)], [], [valid(1)]))).toThrow('缺少作答');
  expect(() => gradeR02Run(...inputs([row(1)], [answer(1)], [
    { id: row(1).id, verdict: { valid: true, findings: ['future_evidence'] } },
  ]))).toThrow('核验结论');
});
