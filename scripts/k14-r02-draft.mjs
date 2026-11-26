import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVerifiedK14 } from './k14-public.mjs';
import { buildReplayInventory, readPages, receiptDates } from './k14-replay-plan.mjs';

const json = (value) => JSON.stringify(value, null, 2) + '\n';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const foldSpace = (value) => value.replace(/\s+/gu, ' ').trim();
const identityText = (value) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const ask = '根据器械用途与结构，判断美国监管类别、产品代码、法规编号和适用的申报路径，并简述依据。';
const codes = /\b(?:LRK|LQZ|BZD|BTT)\b/iu;
const clearance = /K[\s\p{Dash_Punctuation}_]*\d(?:[\s\p{Dash_Punctuation}_]*\d){5}/iu;
const answerText = /\b(?:CFR|PMA|De\s+Novo|Class\s+(?:I|II|III))\b|\b510\s*\(\s*k\s*\)|\b\d{3}\.\d{3,5}\b|(?:第\s*)?(?:[一二三123]|I{1,3})\s*类/iu;

const drafts = [
  {
    id: 'R02-A01', clearanceId: 'K260136',
    descriptionEvidence: [{ page: 5, anchor: 'worn while sleeping to support the lower jaw in a forward position' }],
    description: '一种需要处方、按患者适配且可摘戴的口内器械。夜间佩戴时支撑下颌前移，预期用于缓解年满 18 岁成人的鼾症和轻至中度阻塞性睡眠呼吸暂停。',
    aliases: ['True Function', 'Forza'],
  },
  {
    id: 'R02-A02', clearanceId: 'K260251',
    descriptionEvidence: [
      { page: 5, anchor: 'is a prescription-only Continuous Positive Airway Pressure (CPAP) device' },
      { page: 6, anchor: 'The device uses an embedded software-controlled blower, along with pressure and flow sensors' },
    ],
    description: '一种经处方使用的电动呼吸治疗设备，以风机和压力、流量传感器调节送气，提供持续的气道正压。预期用于体重超过 30 千克的成人阻塞性睡眠呼吸暂停，在家庭或医疗环境中供单个患者使用。',
    aliases: ['Yuwell', 'Yuyue', 'BreathCare', 'YH-390N'],
  },
  {
    id: 'R02-A03', clearanceId: 'K251448',
    descriptionEvidence: [{
      page: 5, anchor: 'an electrically powered Respiratory Humidifier that actively conditions the inspired respiratory gases',
    }],
    description: '一种处理吸入气体的电动器械，通过加热和增湿调节气体。它用于接受机械通气或正压呼吸支持的患者，连接气管导管或面罩所用的呼吸系统。',
    aliases: ['Flexicare', 'FL-10000U'],
  },
];

class DraftError extends Error {}

function check(condition, message) {
  if (!condition) throw new DraftError(message);
}

export function checkQuestion(text, hidden) {
  const normalized = text.normalize('NFKC');
  const compact = identityText(normalized);
  check(!codes.test(normalized) && !clearance.test(normalized) && !answerText.test(normalized) &&
    !hidden.some((name) => {
      const key = identityText(name);
      return key.length > 2 && compact.includes(key);
    }), '题目出现应遮挡的标识或参考答案。');
}

export function decisionFields(page, record) {
  const regulationNumber = /^\s*Regulation Number:\s*21 CFR\s*(\d{3}\.\d{4})[ \t]*$/imu.exec(page)?.[1];
  const deviceClass = /^\s*Regulatory Class:\s*Class\s+(I{1,3})[ \t]*$/imu.exec(page)?.[1];
  const productCode = /^\s*Product Code:\s*([A-Z]{3})[ \t]*$/mu.exec(page)?.[1];
  const id = /^\s*Re:\s*(K\d{6})[ \t]*$/mu.exec(page)?.[1];
  check(id === record.id && regulationNumber && deviceClass && productCode === record.productCode &&
    /section\s+510\s*\(\s*k\s*\)/iu.test(page) && /substantially equivalent/iu.test(page),
  '决定页的申报编号、分类、产品代码或申报路径不明确。');
  return { deviceClass, productCode, regulationNumber, pathway: '510(k)' };
}

async function generate(snapshot) {
  const root = fileURLToPath(new URL('../.local/', import.meta.url));
  const source = await loadVerifiedK14(path.join(root, 'k14'), snapshot);
  check(source.dataset === 'A', 'R02 草案需要已验证的集 A 档案。');
  const pageRoot = path.join(root, 'k14-pages');
  const extraction = await readPages(pageRoot, snapshot, source);
  const inventory = buildReplayInventory(source.index, { licences: [], devices: [], identifiers: [] },
    await receiptDates(source), extraction.pages).us;
  const questions = [];
  const answers = [];
  for (const draft of drafts) {
    const raw = source.index.find(({ id }) => id === draft.clearanceId);
    const candidate = inventory.find(({ id }) => id === draft.clearanceId);
    check(raw && candidate?.disposition === 'pending_question_review' && candidate.summaryPages,
      'R02 草案缺少可复核的摘要页。');
    const metadata = candidate.summaryPages;
    const bytes = await readFile(path.join(pageRoot, snapshot, metadata.file));
    check(sha256(bytes) === metadata.sha256, '已核验的摘要页发生变化。');
    const { pages } = JSON.parse(bytes.toString('utf8'));
    const decision = pages[0];
    check(decision?.method === 'text' && draft.descriptionEvidence.every(({ page, anchor }) =>
      pages[page - 1]?.method === 'text' && foldSpace(pages[page - 1].text).includes(anchor)),
    'R02 草案的物理页或原文锚点不一致。');
    const expected = decisionFields(decision.text, raw);
    const hidden = [raw.applicant, raw.deviceName, ...draft.aliases];
    checkQuestion(draft.description + '\n' + ask, hidden);
    questions.push({ id: draft.id, market: 'US', description: draft.description, ask });
    answers.push({
      id: draft.id, expected, clearanceId: raw.id, applicant: raw.applicant,
      deviceName: raw.deviceName, hidden, evidenceThrough: candidate.knowledgeThrough,
      source: {
        url: raw.summary, sha256: metadata.sourceSha256, pagesSha256: metadata.sha256,
        decisionPage: 1, descriptionEvidence: draft.descriptionEvidence,
      },
    });
  }

  const output = path.join(root, 'k14-r02-drafts');
  await mkdir(output, { recursive: true, mode: 0o700 });
  const id = 'R02-' + new Date().toISOString().slice(0, 19).replace(/[-:]/gu, '') +
    'Z-' + randomBytes(6).toString('hex');
  const pending = path.join(output, '.' + id + '.partial');
  await mkdir(pending, { mode: 0o700 });
  await mkdir(path.join(pending, 'questions'), { mode: 0o700 });
  await mkdir(path.join(pending, 'review'), { mode: 0o700 });
  const write = (name, data) => writeFile(path.join(pending, name), json(data), { flag: 'wx', mode: 0o600 });
  await write('questions/index.json', { version: 1, status: 'review-only', cases: questions });
  await write('review/answers.json', {
    version: 1, status: 'review-only', snapshot,
    manifestSha256: source.manifestSha256, extractionSha256: extraction.manifestSha256,
    trainingCutoff: null, cases: answers,
  });
  await rename(pending, path.join(output, id));
  console.log(JSON.stringify({ draft: id, status: 'review-only', questions: questions.length, answers: answers.length }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [snapshot, extra] = process.argv.slice(2);
    check(snapshot && !extra, '请指定集 A 的档案编号。');
    await generate(snapshot);
  } catch (error) {
    console.error(error instanceof DraftError ? error.message : 'R02 待审题目生成失败。');
    process.exitCode = 1;
  }
}
