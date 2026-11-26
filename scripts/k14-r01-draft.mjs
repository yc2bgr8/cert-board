import { randomBytes } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVerifiedK14 } from './k14-public.mjs';
import { buildReplayInventory, readPages, receiptDates, validDate } from './k14-replay-plan.mjs';

const json = (value) => JSON.stringify(value, null, 2) + '\n';
const dayMs = 86_400_000;
const ask = '用附带的历史审评历时安排预期决定日期。给出样本数、25%/50%/75% 分位的历时（自然日）、从开始日期推算出的三个计划日期，并说明不确定性。先按历时从短到长排序。用分位比例乘样本数，向上取整得出所取项的位置。';

class DraftError extends Error {}

function check(condition, message) {
  if (!condition) throw new DraftError(message);
}

function elapsedDays(start, end) {
  check(validDate(start) && validDate(end) && start <= end, 'FDA 受理或决定日期无效。');
  return (Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / dayMs;
}

function afterDays(start, days) {
  return new Date(Date.parse(start + 'T00:00:00Z') + dayMs * days).toISOString().slice(0, 10);
}

export function durationSummary(durations) {
  check(durations.length > 0 && durations.every((days) => Number.isSafeInteger(days) && days >= 0),
    '历史审评历时不完整。');
  const sorted = [...durations].sort((a, b) => a - b);
  const at = (fraction) => sorted[Math.ceil(fraction * sorted.length) - 1];
  return { samples: sorted.length, p25: at(0.25), p50: at(0.5), p75: at(0.75) };
}

export function buildR01Drafts(candidates, records, received) {
  const answers = [];
  const questions = [];
  const evidence = [];
  const excluded = [];
  for (const candidate of candidates) {
    if (candidate.disposition !== 'pending_question_review') continue;
    check(candidate.receivedOn === received.get(candidate.id) &&
      validDate(candidate.knowledgeThrough) && elapsedDays(candidate.knowledgeThrough, candidate.receivedOn) === 1,
    'R01 题目须使用 FDA 原受理日前一日为证据截止日。');
    const sample = records.filter(({ id, productCode, availableOn }) =>
      id !== candidate.id && productCode === candidate.productCode && availableOn <= candidate.knowledgeThrough);
    if (!sample.length) {
      excluded.push({ clearanceId: candidate.id, reason: 'no_prior_same_code_records' });
      continue;
    }

    const durations = sample.map(({ id, availableOn }) => elapsedDays(received.get(id), availableOn));
    const expected = durationSummary(durations);
    const questionId = 'R01-A' + String(questions.length + 1).padStart(2, '0');
    questions.push({
      id: questionId, market: 'US', productCode: candidate.productCode, startOn: candidate.receivedOn, ask,
    });
    evidence.push({ id: questionId, durationsDays: durations });
    answers.push({
      id: questionId,
      clearanceId: candidate.id,
      evidenceThrough: candidate.knowledgeThrough,
      sampleClearanceIds: sample.map(({ id }) => id),
      expected: {
        ...expected,
        plannedDecisionDates: {
          p25: afterDays(candidate.receivedOn, expected.p25),
          p50: afterDays(candidate.receivedOn, expected.p50),
          p75: afterDays(candidate.receivedOn, expected.p75),
        },
      },
      observed: {
        decisionOn: candidate.decisionOn,
        elapsedDays: elapsedDays(candidate.receivedOn, candidate.decisionOn),
      },
    });
  }
  return { questions, evidence, answers, excluded };
}

async function generate(snapshot) {
  const root = fileURLToPath(new URL('../.local/', import.meta.url));
  const source = await loadVerifiedK14(path.join(root, 'k14'), snapshot);
  check(source.dataset === 'A', 'R01 草案需要已验证的集 A 档案。');
  const extraction = await readPages(path.join(root, 'k14-pages'), snapshot, source);
  const received = await receiptDates(source);
  const inventory = buildReplayInventory(source.index, { licences: [], devices: [], identifiers: [] },
    received, extraction.pages);
  const { questions, evidence, answers, excluded } = buildR01Drafts(inventory.us, source.index, received);
  check(questions.length > 0, '缺少可核验的 R01 题目和审评历时。');

  const output = path.join(root, 'k14-r01-drafts');
  await mkdir(output, { recursive: true, mode: 0o700 });
  const id = 'R01-' + new Date().toISOString().slice(0, 19).replace(/[-:]/gu, '') +
    'Z-' + randomBytes(6).toString('hex');
  const pending = path.join(output, '.' + id + '.partial');
  await mkdir(pending, { mode: 0o700 });
  await mkdir(path.join(pending, 'questions'), { mode: 0o700 });
  await mkdir(path.join(pending, 'review'), { mode: 0o700 });
  const draft = { version: 1, status: 'review-only' };
  const write = (name, data) => writeFile(path.join(pending, name), json(data), { flag: 'wx', mode: 0o600 });
  await write('questions/index.json', { ...draft, cases: questions });
  await write('questions/history.json', { ...draft, cases: evidence });
  await write('review/answers.json', {
    ...draft, snapshot, manifestSha256: source.manifestSha256,
    extractionSha256: extraction.manifestSha256, trainingCutoff: null, cases: answers, excluded,
  });
  await rename(pending, path.join(output, id));

  const counts = answers.map(({ expected }) => expected.samples);
  console.log(JSON.stringify({
    draft: id, status: draft.status, questions: questions.length, noHistory: excluded.length,
    sampleCountRange: [Math.min(...counts), Math.max(...counts)],
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [snapshot, extra] = process.argv.slice(2);
    check(snapshot && !extra, '请指定集 A 的档案编号。');
    await generate(snapshot);
  } catch (error) {
    console.error(error instanceof DraftError ? error.message : 'R01 待审题目生成失败。');
    process.exitCode = 1;
  }
}
