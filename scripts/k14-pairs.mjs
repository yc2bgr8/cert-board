import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, URLSearchParams } from 'node:url';
import { download, loadVerifiedK14, verifyFiles } from './k14-public.mjs';

const mdallCompany = 'https://health-products.canada.ca/api/medical-devices/company/';
const fdaUdi = 'https://api.fda.gov/device/udi.json';
const pairId = /^P-\d{8}T\d{6}Z-[a-f0-9]{12}$/u;
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const nameKey = (name) => name.normalize('NFKC').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function companyKey(name) {
  return nameKey(name.replaceAll('&', ' and '))
    .replace(/(?: (?:co|inc|incorporated|ltd|limited|corp|corporation))+$/u, '');
}

export function nameCandidates(usRows, ca) {
  const devicesByLicence = new Map();
  for (const device of ca.devices) {
    if (!devicesByLicence.has(device.licenceId)) devicesByLicence.set(device.licenceId, []);
    devicesByLicence.get(device.licenceId).push(device);
  }
  const candidates = [];
  for (const us of usRows) {
    const name = nameKey(us.deviceName);
    if (!name) continue;
    for (const licence of ca.licences) {
      const devices = (devicesByLicence.get(licence.id) ?? [])
        .filter((device) => nameKey(device.name) === name);
      const licenceNameMatches = nameKey(licence.name) === name;
      if (!licenceNameMatches && !devices.length) continue;
      const deviceIds = new Set(devices.map(({ id }) => id));
      const identifiers = ca.identifiers.filter((entry) =>
        entry.licenceId === licence.id && deviceIds.has(entry.deviceId));
      candidates.push({ us, licence, devices, identifiers, licenceNameMatches });
    }
  }
  return candidates.sort((a, b) => a.us.id.localeCompare(b.us.id, 'en') || a.licence.id - b.licence.id);
}

export function companyRecord(payload, id) {
  const rows = Array.isArray(payload) ? payload : [payload];
  const [row] = rows;
  if (rows.length !== 1 || row?.company_id !== id ||
      typeof row.company_name !== 'string' || !row.company_name.trim()) {
    throw new Error('MDALL 公司回执没有唯一对应指定编号。');
  }
  return { id, name: row.company_name, status: row.company_status ?? null };
}

const identifierKey = (value) => typeof value === 'string'
  ? value.normalize('NFKC').toUpperCase().replace(/[\s\p{Dash_Punctuation}]+/gu, '')
  : '';

function knownBy(value, through) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
      value < '2013-01-01' || value > through)
    return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function udiRecords(payload, id, through, httpStatus) {
  if (httpStatus === 404 && payload?.error?.code === 'NOT_FOUND') return [];
  const rows = payload?.results;
  if (httpStatus !== 200 || !Array.isArray(rows) || rows.length === 0 ||
      payload.meta?.results?.total !== rows.length)
    throw new Error('FDA UDI 回执缺少完整的结果。');
  return rows.map((row) => {
    const key = row?.public_device_record_key ?? row?.record_key;
    if (!Array.isArray(row?.premarket_submissions) ||
        !row.premarket_submissions.some((x) => x?.submission_number === id) ||
        typeof key !== 'string' || !key.trim() ||
        !knownBy(row.publish_date, through) || !knownBy(row.public_version_date, through)) {
      throw new Error('FDA UDI 回执含范围外的申报编号或日期。');
    }
    return { ...row, record_key: key };
  });
}

export function pairIndex(candidates, companies, udi) {
  return candidates.map(({ us, licence, devices, identifiers, licenceNameMatches }) => {
    const company = companies.get(licence.companyId);
    if (!company) throw new Error('缺少配对候选的公司回执。');
    const matches = [];
    for (const identifier of identifiers) {
      const key = identifierKey(identifier.value);
      if (!key) continue;
      for (const record of udi.get(us.id) ?? []) {
        for (const field of ['version_or_model_number', 'catalog_number', 'brand_name']) {
          if (identifierKey(record[field]) === key) matches.push({
            deviceId: identifier.deviceId, identifier: identifier.value, field,
            recordKey: record.record_key, value: record[field],
            publicVersionDate: record.public_version_date,
          });
        }
      }
    }
    return {
      us, licence, devices, identifiers, licenceNameMatches, company,
      companyNameMatches: Boolean(companyKey(us.applicant)) && companyKey(us.applicant) === companyKey(company.name),
      udiMatches: matches.sort((a, b) => a.deviceId - b.deviceId ||
        a.identifier.localeCompare(b.identifier, 'en') ||
        a.recordKey.localeCompare(b.recordKey, 'en') || a.field.localeCompare(b.field, 'en')),
      status: 'pending-review',
    };
  });
}

async function readInputs(root, aId, cId) {
  const a = await loadVerifiedK14(root, aId);
  const c = await loadVerifiedK14(root, cId);
  if (a.dataset !== 'A' || c.dataset !== 'C' || a.through !== c.through)
    throw new Error('配对需要同一截止日期的 A 和活动 C 档案。');
  const input = {
    a: { id: aId, sha256: a.manifestSha256 },
    c: { id: cId, sha256: c.manifestSha256 },
  };
  const candidates = nameCandidates(a.index, c.index);
  const companyIds = [...new Set(candidates.map(({ licence }) => licence.companyId))].sort((a, b) => a - b);
  const companySources = companyIds.map((id) => ({
    file: 'company-' + id + '.json', url: mdallCompany + '?' + new URLSearchParams({ id, type: 'json' }),
  }));
  const documents = new Map();
  for (const { us } of candidates) {
    if (!/^K\d{6}$/u.test(us.id)) throw new Error('FDA 配对候选编号无效。');
    if (us.summary) documents.set(us.id, { file: us.id + '.pdf', url: us.summary });
  }
  const through = a.through;
  const date = through.replaceAll('-', '');
  const fdaIds = [...new Set(candidates.map(({ us }) => us.id))];
  const udiSources = fdaIds.map((id) => ({
    file: 'udi-' + id + '.json',
    url: fdaUdi + '?' + new URLSearchParams({
      search: 'premarket_submissions.submission_number:"' + id +
        '" AND publish_date:[20130101 TO ' + date + '] AND public_version_date:[20130101 TO ' + date + ']',
      limit: '1000',
    }),
  }));
  return {
    input, through, candidates, companyIds, companySources, fdaIds, udiSources, pdfSources: [...documents.values()],
  };
}

async function project(info, directory, udiEntries) {
  const companies = new Map();
  for (const [position, id] of info.companyIds.entries()) {
    const file = info.companySources[position].file;
    const company = companyRecord(JSON.parse(await readFile(path.join(directory, file), 'utf8')), id);
    companies.set(id, company);
  }
  const udi = new Map();
  for (const [position, id] of info.fdaIds.entries()) {
    const file = info.udiSources[position].file;
    const payload = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
    udi.set(id, udiRecords(payload, id, info.through, udiEntries[position].httpStatus));
  }
  return pairIndex(info.candidates, companies, udi);
}

function summary(index, manifest) {
  return {
    pairs: index.length,
    matchingCompanyNames: index.filter(({ companyNameMatches }) => companyNameMatches).length,
    matchingModelOrCatalogue: index.filter(({ udiMatches }) =>
      udiMatches.some(({ field }) => field !== 'brand_name')).length,
    matchingUdiBrand: index.filter(({ udiMatches }) =>
      udiMatches.some(({ field }) => field === 'brand_name')).length,
    pdfsSaved: manifest.pdfs.filter(({ status }) => status === 'saved').length,
  };
}

async function collect(root, aId, cId) {
  const info = await readInputs(root, aId, cId);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/gu, '');
  const id = 'P-' + stamp + 'Z-' + randomBytes(6).toString('hex');
  const pending = path.join(root, '.' + id + '.partial');
  await mkdir(pending, { mode: 0o700 });
  const companies = [];
  for (const source of info.companySources) companies.push(await download(source, pending));
  const identifications = [];
  for (const source of info.udiSources)
    identifications.push(await download(source, pending, { allowMissingFdaCode: true }));
  const index = await project(info, pending, identifications);
  const pdfs = [];
  for (const source of info.pdfSources) pdfs.push(await download(source, pending, { pdf: true }));
  const manifest = { version: 1, input: info.input, through: info.through, companies, identifications, pdfs };
  await writeFile(path.join(pending, 'manifest.json'), json(manifest), { mode: 0o600, flag: 'wx' });
  await writeFile(path.join(pending, 'index.json'), json(index), { mode: 0o600, flag: 'wx' });
  await rename(pending, path.join(root, id));
  console.log(JSON.stringify({ snapshot: id, ...summary(index, manifest) }));
}

async function verify(root, id) {
  if (!pairId.test(id ?? '')) throw new Error('请输入完整的配对档案编号。');
  const directory = path.join(root, id);
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1) throw new Error('配对档案版本无效。');
  const info = await readInputs(root, manifest.input?.a?.id, manifest.input?.c?.id);
  if (json(manifest.input) !== json(info.input) || manifest.through !== info.through)
    throw new Error('配对档案与来源清单的绑定无效。');
  await verifyFiles(directory, info.companySources, manifest.companies);
  await verifyFiles(directory, info.udiSources, manifest.identifications);
  await verifyFiles(directory, info.pdfSources, manifest.pdfs, true);
  const index = await project(info, directory, manifest.identifications);
  if (await readFile(path.join(directory, 'index.json'), 'utf8') !== json(index))
    throw new Error('配对档案与离线重算结果不符。');
  console.log(JSON.stringify({ verified: id, ...summary(index, manifest) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL('../.local/k14/', import.meta.url));
    const [action, first, second, extra] = process.argv.slice(2);
    if (action === 'collect' && first && second && !extra) await collect(root, first, second);
    else if (action === 'verify' && first && !second) await verify(root, first);
    else throw new Error('请指定 A 和 C 的档案编号，复验时指定配对档案编号。');
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    console.error(/^[\p{Script=Han} A-Za-z0-9_、。 -]{1,100}$/u.test(message) && /\p{Script=Han}/u.test(message)
      ? message : '公开配对档案操作未完成。');
    process.exitCode = 1;
  }
}
