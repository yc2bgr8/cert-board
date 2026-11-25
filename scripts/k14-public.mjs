import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, lstat, open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, URLSearchParams } from 'node:url';

const fdaCodes = ['LRK', 'LQZ', 'BZD', 'BTT'];
const caNames = ['CPAP', 'POSITIVE AIRWAY', 'SLEEP APNEA', 'HUMIDIF'];
const fda = 'https://api.fda.gov/device/510k.json';
const mdall = 'https://health-products.canada.ca/api/medical-devices/';
const fdaPdf = 'https://www.accessdata.fda.gov/cdrh_docs/';
const candidateStart = '2026-01-01';
const maxJson = 128 * 1024 * 1024;
const maxPdf = 20 * 1024 * 1024;
const maxMdallIdentifiers = 384 * 1024 * 1024;
const snapshotName = /^[AC]-\d{8}T\d{6}Z-[a-f0-9]{12}$/u;

class DatasetError extends Error {}

function requireValue(condition, message) {
  if (!condition) throw new DatasetError(message);
}

function date(value) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value), '日期须使用 YYYY-MM-DD。');
  const time = new Date(value + 'T00:00:00Z');
  requireValue(!Number.isNaN(time.getTime()) && time.toISOString().slice(0, 10) === value, '日期无效。');
  return value;
}

function rows(value) {
  requireValue(Array.isArray(value), '官方资料的记录列表格式不符。');
  return value;
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function url(base, params) {
  return base + '?' + new URLSearchParams(params).toString();
}

export function expectedSources(dataset, through) {
  date(through);
  requireValue(through >= '2016-01-01', '公开回放的日期须在 2016 年及之后。');
  if (dataset === 'A')
    return fdaCodes.map((code) => ({
      file: 'fda-' + code + '.json',
      url: url(fda, {
        search: 'product_code:' + code + ' AND decision_code:SESE AND decision_date:[20160101 TO ' + through.replaceAll('-', '') + ']',
        limit: '1000',
      }),
    }));
  requireValue(dataset === 'C', '公开回放数据集须为 A 或 C。');
  return [
    ...caNames.map((name) => ({
      file: 'mdall-' + name.toLowerCase().replaceAll(' ', '-') + '.json',
      url: url(mdall + 'licence/', { state: 'active', licence_name: name, lang: 'en', type: 'json' }),
    })),
    ...['device', 'deviceidentifier'].map((part) => ({
      file: 'mdall-' + part + '.json',
      url: url(mdall + part + '/', { state: 'active', type: 'json' }),
    })),
  ];
}

function addUnique(map, key, entry, reason) {
  const previous = map.get(key);
  requireValue(!previous || JSON.stringify(previous) === JSON.stringify(entry), reason);
  if (!previous) map.set(key, entry);
}

const deviceKey = (licenceId, deviceId) => licenceId + ':' + deviceId;

export function indexFda(payloads, through) {
  date(through);
  const indexed = new Map();
  requireValue(payloads.length === fdaCodes.length, 'FDA 产品代码档案缺失。');
  for (const [index, code] of fdaCodes.entries()) {
    const payload = payloads[index];
    if (payload?.error?.code === 'NOT_FOUND') continue;
    const list = rows(payload?.results);
    requireValue(payload?.meta?.results?.total === list.length, 'FDA 结果截断，须先补齐完整记录。');
    for (const row of list) {
      const availableOn = date(row?.decision_date);
      requireValue(
        /^K\d{6}$/u.test(row?.k_number) && row.product_code === code && row.decision_code === 'SESE' &&
          availableOn >= '2016-01-01' && availableOn <= through,
        'FDA 记录超出查询范围。',
      );
      requireValue(nonempty(row.applicant) && nonempty(row.device_name), 'FDA 记录缺少申请人或器械名。');
      const id = row.k_number;
      addUnique(indexed, id, {
        id, availableOn, productCode: code, applicant: row.applicant, deviceName: row.device_name,
        summary: row.statement_or_summary === 'Summary' ? fdaPdf + 'pdf' + id.slice(1, 3) + '/' + id + '.pdf' : null,
        cohort: availableOn >= candidateStart ? 'candidate-2026' : 'earlier',
      }, 'FDA 同一编号的档案出现冲突。');
    }
  }
  return [...indexed.values()].sort((a, b) => a.id.localeCompare(b.id, 'en'));
}

export function indexMdall(payloads, through) {
  date(through);
  requireValue(payloads.length === caNames.length + 2, 'MDALL 许可、器械或标识档案缺失。');
  const licences = new Map();
  for (const [index, name] of caNames.entries()) {
    for (const row of rows(payloads[index])) {
      requireValue(positive(row?.original_licence_no) && nonempty(row.licence_name) &&
        row.licence_name.toUpperCase().includes(name) && row.end_date === null,
      'MDALL 许可检索返回范围外记录。');
      const availableOn = date(row.first_licence_status_dt);
      if (availableOn > through) continue;
      requireValue(nonempty(row.licence_type_cd) && positive(row.company_id) && positive(row.appl_risk_class),
        'MDALL 许可缺少类型、类别或公司编号。');
      addUnique(licences, row.original_licence_no, {
        id: row.original_licence_no, availableOn, name: row.licence_name, type: row.licence_type_cd,
        riskClass: row.appl_risk_class, companyId: row.company_id,
        cohort: availableOn >= candidateStart ? 'candidate-2026' : 'earlier',
      }, 'MDALL 同一许可的档案出现冲突。');
    }
  }
  const devices = new Map();
  for (const row of rows(payloads[caNames.length])) {
    if (!licences.has(row?.original_licence_no)) continue;
    const availableOn = date(row.first_licence_dt);
    if (availableOn > through) continue;
    requireValue(positive(row.device_id) && nonempty(row.trade_name) && row.end_date === null,
      'MDALL 器械记录与活动许可范围不符。');
    addUnique(devices, deviceKey(row.original_licence_no, row.device_id), {
      id: row.device_id, licenceId: row.original_licence_no, name: row.trade_name, availableOn,
    }, 'MDALL 同一器械的档案出现冲突。');
  }
  const identifiers = new Map();
  for (const row of rows(payloads[caNames.length + 1])) {
    if (!licences.has(row?.original_licence_no)) continue;
    const key = deviceKey(row.original_licence_no, row.device_id);
    const device = devices.get(key);
    if (!device) continue;
    const availableOn = date(row.first_licence_dt);
    if (availableOn > through) continue;
    requireValue(nonempty(row.device_identifier) && row.end_date === null,
      'MDALL 型号标识与许可归属不符。');
    addUnique(identifiers, key + ':' + row.device_identifier, {
      licenceId: device.licenceId, deviceId: row.device_id, value: row.device_identifier, availableOn,
    }, 'MDALL 同一型号标识的档案出现冲突。');
  }
  return {
    licences: [...licences.values()].sort((a, b) => a.id - b.id),
    devices: [...devices.values()].sort((a, b) => a.licenceId - b.licenceId || a.id - b.id),
    identifiers: [...identifiers.values()].sort((a, b) =>
      a.licenceId - b.licenceId || a.deviceId - b.deviceId || a.value.localeCompare(b.value, 'en')),
  };
}

function hash() {
  let bytes = 0;
  const h = createHash('sha256');
  return {
    update(chunk) { bytes += chunk.length; h.update(chunk); },
    result() { return { bytes, sha256: h.digest('hex') }; },
  };
}

function maxSourceBytes(file) {
  if (file === 'mdall-deviceidentifier.json') return maxMdallIdentifiers;
  return file.endsWith('.pdf') ? maxPdf : maxJson;
}

async function download(spec, root, { pdf = false, allowMissingFdaCode = false } = {}) {
  let response;
  try {
    response = await fetch(spec.url, { redirect: 'error', signal: AbortSignal.timeout(180_000) });
  } catch {
    if (pdf) return { ...spec, status: 'unavailable' };
    throw new DatasetError('官方来源请求未完成。档案未发布。');
  }
  if (!response.ok && !(allowMissingFdaCode && response.status === 404)) {
    await response.body?.cancel();
    if (pdf) return { ...spec, status: 'unavailable', httpStatus: response.status };
    throw new DatasetError('官方来源返回 HTTP ' + response.status + '，档案未发布。');
  }
  const mime = response.headers.get('content-type') ?? '';
  if (!mime.includes(pdf ? 'application/pdf' : 'application/json') || !response.body) {
    await response.body?.cancel();
    if (pdf) return { ...spec, status: 'invalid_content' };
    throw new DatasetError('官方来源内容类型不符。');
  }
  const file = path.join(root, spec.file);
  const measure = hash();
  let size = 0;
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > maxSourceBytes(spec.file)) return callback(new DatasetError('官方档案超过单文件大小上限。'));
      measure.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  if (pdf) {
    const descriptor = await open(file, 'r');
    const header = Buffer.alloc(5);
    try { await descriptor.read(header, 0, header.length, 0); } finally { await descriptor.close(); }
    requireValue(header.toString('ascii') === '%PDF-', 'FDA 摘要的文件签名无效。');
  }
  return { ...spec, status: 'saved', httpStatus: response.status, receivedAt: new Date().toISOString(), ...measure.result() };
}

const serialized = (value) => JSON.stringify(value, null, 2) + '\n';

async function buildIndex(dataset, through, root, files) {
  const payloads = [];
  for (const { file } of files) payloads.push(JSON.parse(await readFile(path.join(root, file), 'utf8')));
  return dataset === 'A' ? indexFda(payloads, through) : indexMdall(payloads, through);
}

function pdfSources(dataset, index) {
  return dataset === 'A'
    ? index.filter((row) => row.cohort === 'candidate-2026' && row.summary).map((row) => ({
        file: row.id + '.pdf', url: row.summary,
      }))
    : [];
}

function counts(dataset, index, pdfs) {
  const records = dataset === 'A' ? index : index.licences;
  return {
    records: records.length,
    candidates2026: records.filter((row) => row.cohort === 'candidate-2026').length,
    ...(dataset === 'A' ? { pdfsSaved: pdfs.filter((pdf) => pdf.status === 'saved').length, pdfsExpected: pdfs.length }
      : { devices: index.devices.length, identifiers: index.identifiers.length }),
  };
}

async function collect(root, dataset, through) {
  const specs = expectedSources(dataset, through);
  const started = new Date().toISOString();
  requireValue(through <= started.slice(0, 10), '不得用未来日期采集公开档案。');
  const id = dataset + '-' + started.slice(0, 19).replace(/[-:]/gu, '') + 'Z-' + randomBytes(6).toString('hex');
  const directory = path.join(root, '.' + id + '.partial');
  await mkdir(directory, { mode: 0o700 });
  const sources = [];
  for (const spec of specs) {
    sources.push(await download(spec, directory, { allowMissingFdaCode: dataset === 'A' }));
    console.log('已归档 ' + spec.file);
  }
  const index = await buildIndex(dataset, through, directory, specs);
  const pdfs = [];
  for (const spec of pdfSources(dataset, index)) pdfs.push(await download(spec, directory, { pdf: true }));
  const manifest = { version: 1, dataset, through, sources, pdfs, counts: counts(dataset, index, pdfs) };
  await writeFile(path.join(directory, 'index.json'), serialized(index), { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(directory, 'manifest.json'), serialized(manifest), { flag: 'wx', mode: 0o600 });
  await rename(directory, path.join(root, id));
  console.log(JSON.stringify({ snapshot: id, dataset, ...manifest.counts }));
}

async function verifyFiles(directory, specs, archived, optional = false) {
  requireValue(Array.isArray(archived) && archived.length === specs.length, '档案清单不完整。');
  for (const [index, spec] of specs.entries()) {
    const entry = archived[index];
    requireValue(entry?.file === spec.file && entry.url === spec.url, '档案来源与查询计划不符。');
    if (optional && ['unavailable', 'invalid_content'].includes(entry.status)) continue;
    const file = path.join(directory, spec.file);
    const info = await lstat(file);
    requireValue(entry.status === 'saved' && info.isFile() && info.size === entry.bytes &&
      info.size <= maxSourceBytes(spec.file) && /^\d{4}-\d{2}-\d{2}T/u.test(entry.receivedAt),
    '档案文件尺寸或类型不符。');
    const measure = hash();
    for await (const chunk of createReadStream(file)) measure.update(chunk);
    requireValue(measure.result().sha256 === entry.sha256, '官方档案 SHA-256 校验失败。');
  }
}

export async function loadVerifiedK14(root, id) {
  requireValue(snapshotName.test(id ?? ''), '请输入完整的公开档案编号。');
  const directory = path.join(root, id);
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  requireValue(manifest.version === 1 && id.startsWith(manifest.dataset + '-'), '档案版本或数据集不符。');
  const specs = expectedSources(manifest.dataset, manifest.through);
  await verifyFiles(directory, specs, manifest.sources);
  const index = await buildIndex(manifest.dataset, manifest.through, directory, specs);
  await verifyFiles(directory, pdfSources(manifest.dataset, index), manifest.pdfs, true);
  const recalculated = counts(manifest.dataset, index, manifest.pdfs);
  requireValue(serialized(index) === await readFile(path.join(directory, 'index.json'), 'utf8') &&
    serialized(recalculated) === serialized(manifest.counts), '离线重算与已保存的索引不符。');
  return { directory, dataset: manifest.dataset, through: manifest.through, pdfs: manifest.pdfs, counts: recalculated };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL('../.local/k14/', import.meta.url));
    const [action, first, second, extra] = process.argv.slice(2);
    requireValue(!extra && (action === 'collect' || (action === 'verify' && !second)),
      '使用 pnpm k14:collect <A 或 C> <截至日期> 或 pnpm k14:verify <档案编号>。');
    if (action === 'collect') {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await collect(root, first, second);
    } else {
      const { dataset, counts: recalculated } = await loadVerifiedK14(root, first);
      console.log(JSON.stringify({ verified: first, dataset, ...recalculated }));
    }
  } catch (error) {
    console.error(error instanceof DatasetError ? error.message : '公开档案操作未完成。');
    process.exitCode = 1;
  }
}
