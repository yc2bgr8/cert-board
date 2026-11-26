import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fields = ['deviceClass', 'productCode', 'regulationNumber', 'pathway'];
const findings = new Set(['future_evidence', 'source_date_unavailable', 'target_identifier_in_evidence']);
const statuses = ['scored', 'invalid_replay', 'unverified_replay', 'missing_response'];
const maxFile = 1024 * 1024;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clean = (value) => String(value ?? '').normalize('NFKC').trim().toUpperCase();
const answerValue = (field, value) => (typeof value === 'string' && value.length <= 160) ||
  (field === 'deviceClass' && [1, 2, 3].includes(value));

class GradeError extends Error {}

function check(condition, message) {
  if (!condition) throw new GradeError(message);
}

function normalize(field, value) {
  const text = clean(value);
  if (field === 'deviceClass') {
    const match = /^(?:CLASS\s+|第\s*)?(I{1,3}|[123])(?:\s*类)?$/u.exec(text)?.[1];
    return ['I', 'II', 'III'][Number(match) - 1] ?? match;
  }
  if (field === 'productCode') return /^[A-Z]{3}$/u.test(text) ? text : undefined;
  if (field === 'regulationNumber')
    return /^(?:21\s*CFR\s*)?(?:§\s*)?(\d{3}\.\d{4})$/u.exec(text)?.[1];
  if (/^(?:(?:TRADITIONAL|ABBREVIATED|SPECIAL|传统|简化|特殊)\s*)?510\s*\(\s*K\s*\)$/u.test(text))
    return '510(k)';
  if (/^DE[\s-]+NOVO$/u.test(text)) return 'De Novo';
  return text === 'PMA' ? text : undefined;
}

function rows(document, label) {
  check(document?.version === 1 && Array.isArray(document.cases), label + '文件版本或题目列表无效。');
  const cases = new Map();
  for (const row of document.cases) {
    check(object(row) && /^R02-[a-z0-9-]{1,48}$/iu.test(row.id ?? '') && !cases.has(row.id),
      label + '含无效或重复的题号。');
    cases.set(row.id, row);
  }
  return cases;
}

function validateResponse(response) {
  check(object(response) && Object.keys(response).every((key) => [...fields, 'reasoning'].includes(key)),
    '作答格式有未登记字段。');
  for (const field of fields) {
    const value = response[field];
    check(value == null || answerValue(field, value), '作答字段格式不符。');
  }
  check(response.reasoning == null || (typeof response.reasoning === 'string' && response.reasoning.length <= 4000),
    '作答依据格式不符。');
}

function validateReplay(verdict) {
  check(object(verdict) && typeof verdict.valid === 'boolean' && Array.isArray(verdict.findings) &&
    verdict.findings.every((item) => findings.has(item)) &&
    new Set(verdict.findings).size === verdict.findings.length && verdict.valid === (verdict.findings.length === 0),
  '回放核验结论格式不符。');
}

function gradeCase(key, submitted, replay) {
  const { id, expected } = key;
  check(object(expected) && fields.every((field) => answerValue(field, expected[field]) && normalize(field, expected[field])),
    '参考答案缺少可判定字段。');
  if (submitted) validateResponse(submitted.response);
  if (replay) validateReplay(replay.verdict);
  if (replay && !replay.verdict.valid)
    return { id, status: 'invalid_replay', findings: replay.verdict.findings };
  if (!submitted) return { id, status: 'missing_response' };
  if (!replay) return { id, status: 'unverified_replay' };

  const outcomes = Object.fromEntries(fields.map((field) => {
    const given = submitted.response[field];
    let outcome = 'incorrect';
    if (given == null || (typeof given === 'string' && !given.trim())) outcome = 'missing';
    else if (normalize(field, given) === normalize(field, expected[field])) outcome = 'correct';
    return [field, outcome];
  }));
  const correctFields = Object.values(outcomes).filter((status) => status === 'correct').length;
  return { id, status: 'scored', fields: outcomes, correctFields, totalFields: fields.length };
}

export function gradeR02Run(keyBytes, responseBytes, replayBytes) {
  const key = JSON.parse(keyBytes.toString('utf8'));
  const response = JSON.parse(responseBytes.toString('utf8'));
  const replay = JSON.parse(replayBytes.toString('utf8'));
  const input = { answerKeySha256: sha256(keyBytes), responsesSha256: sha256(responseBytes) };
  check(key?.status === 'review-only', '只允许使用待审的参考答案判分。');
  check(replay?.answerKeySha256 === input.answerKeySha256 && replay?.responsesSha256 === input.responsesSha256,
    '回放核验记录与答案或作答文件的摘要不符。');
  const answers = rows(key, '参考答案');
  const submitted = rows(response, '作答');
  const verified = rows(replay, '回放核验');
  for (const id of [...submitted.keys(), ...verified.keys()])
    check(answers.has(id), '作答或回放核验含未登记题号。');
  for (const row of verified.values())
    check(submitted.has(row.id) || !row.verdict?.valid, '缺少作答的题目不能标为回放通过。');

  const cases = [...answers].map(([id, answer]) => gradeCase(answer, submitted.get(id), verified.get(id)));
  const scored = cases.filter(({ status }) => status === 'scored');
  return {
    status: 'review-only',
    input: { ...input, replaySha256: sha256(replayBytes) },
    cases,
    summary: {
      totalCases: cases.length,
      casesByStatus: Object.fromEntries(statuses.map((status) =>
        [status, cases.filter((row) => row.status === status).length])),
      fullyCorrectCases: scored.filter(({ correctFields, totalFields }) => correctFields === totalFields).length,
      correctFields: scored.reduce((total, row) => total + row.correctFields, 0),
      scoredFields: scored.length * fields.length,
    },
  };
}

async function readJsonFile(file) {
  const info = await lstat(file);
  check(info.isFile() && info.size > 0 && info.size <= maxFile, '判分文件的类型或大小不符。');
  return readFile(file);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const files = process.argv.slice(2);
    check(files.length === 3, '请分别传入参考答案、作答结果和判分方的回放核验文件。');
    const result = gradeR02Run(...await Promise.all(files.map(readJsonFile)));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof GradeError ? error.message : 'R02 待审判分失败。');
    process.exitCode = 1;
  }
}
