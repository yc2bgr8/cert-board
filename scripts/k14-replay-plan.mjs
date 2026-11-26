import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedSources, loadVerifiedK14 } from './k14-public.mjs';

const sha = /^[a-f0-9]{64}$/u;
const maxPageFile = 48 * 1024 * 1024;
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
// These public records may overlap the company cases used in development.
const reserved = new Set(['K251920', 'K253845', 'K262104']);
const developmentCompanyId = 184937;

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const time = new Date(value + 'T00:00:00Z');
  return Number.isFinite(time.valueOf()) && time.toISOString().slice(0, 10) === value;
}

function dayBefore(value) {
  const time = new Date(value + 'T00:00:00Z');
  time.setUTCDate(time.getUTCDate() - 1);
  return time.toISOString().slice(0, 10);
}

class ReplayPlanError extends Error {}

function check(condition, message) {
  if (!condition) throw new ReplayPlanError(message);
}

function afterCutoff(value, model) {
  return model ? value > model.trainingCutoff : null;
}

function countBy(rows, select) {
  const counts = new Map();
  for (const row of rows) {
    const value = select(row);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
}

export function buildReplayInventory(a, c, receiptDates, pages, model = null) {
  if (model) check(/^[a-z0-9][a-z0-9./:_-]{0,119}$/iu.test(model.id ?? '') &&
    validDate(model.trainingCutoff), '模型编号或训练截止日期无效。');

  const us = a.filter(({ cohort }) => cohort === 'candidate-2026').map((row) => {
    const receivedOn = receiptDates.get(row.id);
    check(validDate(receivedOn) && receivedOn <= row.availableOn, 'FDA 受理日期缺失或晚于决定日期。');
    const knowledgeThrough = dayBefore(receivedOn);
    const pageEvidence = pages.get(row.id) ?? null;
    return {
      id: row.id,
      receivedOn,
      knowledgeThrough,
      decisionOn: row.availableOn,
      productCode: row.productCode,
      afterTrainingCutoff: afterCutoff(row.availableOn, model),
      disposition: reserved.has(row.id) ? 'reserved_development_overlap' :
        pageEvidence ? 'pending_question_review' : 'missing_parsed_source',
      summaryPages: pageEvidence,
      priorSameCodeCount: a.filter(({ id, productCode, availableOn }) =>
        id !== row.id && productCode === row.productCode && availableOn <= knowledgeThrough).length,
    };
  });
  const canada = c.licences.filter(({ cohort }) => cohort === 'candidate-2026').map((row) => ({
    id: row.id,
    issuedOn: row.availableOn,
    riskClass: row.riskClass,
    licenceType: row.type,
    afterTrainingCutoff: afterCutoff(row.availableOn, model),
    disposition: row.companyId === developmentCompanyId
      ? 'reserved_development_overlap' : 'missing_reviewed_description_and_replay_date',
    devices: c.devices.filter(({ licenceId }) => licenceId === row.id).length,
    identifiers: c.identifiers.filter(({ licenceId }) => licenceId === row.id).length,
  }));
  return { status: 'review-only', model, us, canada };
}

async function receiptDates(source) {
  const received = new Map();
  for (const { file } of expectedSources('A', source.through)) {
    const document = JSON.parse(await readFile(path.join(source.directory, file), 'utf8'));
    for (const row of document.results ?? []) {
      const existing = received.get(row.k_number);
      check(!received.has(row.k_number) || existing === row.date_received, '同一 FDA 申报编号的受理日期冲突。');
      received.set(row.k_number, row.date_received);
    }
  }
  return received;
}

async function readPages(root, snapshot, source) {
  const directory = path.join(root, snapshot);
  const manifestBytes = await readFile(path.join(directory, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  check(manifest.version === 1 && manifest.sourceSnapshot === snapshot &&
    manifest.through === source.through && /^sha256:[a-f0-9]{64}$/u.test(manifest.parserImage ?? '') &&
    Array.isArray(manifest.files), '摘要逐页清单来源或版本不符。');
  const entries = new Map(manifest.files.map((row) => [row.file, row]));
  check(entries.size === manifest.files.length && entries.size === source.pdfs.length, '摘要逐页清单不完整。');

  const pages = new Map();
  for (const original of source.pdfs) {
    const id = original.file.slice(0, -4);
    const file = id + '.pages.json';
    if (original.status !== 'saved') {
      check(entries.get(original.file)?.status === 'source_unavailable', '缺失摘要的逐页清单不符。');
      continue;
    }
    const entry = entries.get(file) ?? entries.get(original.file);
    check(entry?.sourceSha256 === original.sha256, '摘要逐页文件未绑定原件。');
    if (entry.file === original.file && entry.status === 'parse_failed') continue;
    check(entry.file === file && entry.status === 'parsed' && sha.test(entry.sha256 ?? ''),
      '摘要逐页清单缺少成功解析的摘要。');
    const filename = path.join(directory, file);
    const info = await lstat(filename);
    check(info.isFile() && info.size > 0 && info.size <= maxPageFile, '摘要逐页文件尺寸不符。');
    const bytes = await readFile(filename);
    check(sha256(bytes) === entry.sha256, '摘要逐页文件 SHA-256 校验失败。');
    const item = JSON.parse(bytes.toString('utf8'));
    check(item.sourceSha256 === original.sha256 && Array.isArray(item.pages) &&
      item.pages.length > 0 && item.pages.length === entry.pages &&
      item.pages.every((page, index) =>
        page?.page === index + 1 && ['text', 'ocr'].includes(page.method) && typeof page.text === 'string'),
    '摘要逐页内容的原件或页码不符。');
    const blank = item.pages.filter(({ text }) => !text.trim()).length;
    check(blank === entry.blankPages, '摘要逐页空白页与清单不符。');
    if (blank < item.pages.length) pages.set(id, {
      file, pageCount: item.pages.length, blankPages: blank, sha256: entry.sha256,
      sourceSha256: original.sha256,
    });
  }
  return { pages, manifestSha256: sha256(manifestBytes) };
}

async function prepare(aId, cId, model) {
  const archives = fileURLToPath(new URL('../.local/k14/', import.meta.url));
  const extraction = fileURLToPath(new URL('../.local/k14-pages/', import.meta.url));
  const output = fileURLToPath(new URL('../.local/k14-plans/', import.meta.url));
  const a = await loadVerifiedK14(archives, aId);
  const c = await loadVerifiedK14(archives, cId);
  check(a.dataset === 'A' && c.dataset === 'C' && a.through === c.through,
    '候选清单须使用同一截止日期的 A 和活动 C 档案。');
  const pages = await readPages(extraction, aId, a);
  const plan = buildReplayInventory(a.index, c.index, await receiptDates(a), pages.pages, model);
  const input = {
    a: { id: aId, sha256: a.manifestSha256 },
    c: { id: cId, sha256: c.manifestSha256 },
    extraction: { id: aId, sha256: pages.manifestSha256 },
  };
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/gu, '');
  const id = 'R-' + stamp + 'Z-' + randomBytes(6).toString('hex');
  await mkdir(output, { recursive: true, mode: 0o700 });
  const pending = path.join(output, '.' + id + '.partial');
  await mkdir(pending, { mode: 0o700 });
  await writeFile(path.join(pending, 'inventory.json'), json({
    version: 1, through: a.through, input, ...plan,
  }), { flag: 'wx', mode: 0o600 });
  await rename(pending, path.join(output, id));
  console.log(JSON.stringify({
    inventory: id, status: plan.status,
    usRecords: plan.us.length,
    usWithParsedSource: plan.us.filter(({ summaryPages }) => summaryPages).length,
    usReserved: plan.us.filter(({ disposition }) => disposition === 'reserved_development_overlap').length,
    usPendingReview: plan.us.filter(({ disposition }) => disposition === 'pending_question_review').length,
    usProductCodes: countBy(plan.us, ({ productCode }) => productCode),
    canadaRecords: plan.canada.length,
    canadaReserved: plan.canada.filter(({ disposition }) => disposition === 'reserved_development_overlap').length,
    canadaRiskClasses: countBy(plan.canada, ({ riskClass }) => riskClass),
    afterTrainingCutoff: model ? {
      us: plan.us.filter((row) => row.afterTrainingCutoff).length,
      canada: plan.canada.filter((row) => row.afterTrainingCutoff).length,
    } : null,
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [a, c, modelId, trainingCutoff, extra] = process.argv.slice(2);
    check(a && c && !extra && Boolean(modelId) === Boolean(trainingCutoff),
      '请指定 A 与 C 的档案编号，模型编号和训练截止日期须同时提供。');
    const model = modelId ? { id: modelId, trainingCutoff } : null;
    await prepare(a, c, model);
  } catch (error) {
    console.error(error instanceof ReplayPlanError ? error.message : '候选清单准备未完成。');
    process.exitCode = 1;
  }
}
