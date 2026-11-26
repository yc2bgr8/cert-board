import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { expectedSources, indexFda, indexMdall, indexMdallHistory, loadVerifiedK14 } from './k14-public.mjs';

const through = '2026-11-25';
const fda = {
  k_number: 'K269999', product_code: 'LRK', decision_code: 'SESE', decision_date: '2026-09-03',
  applicant: 'Synthetic Applicant', device_name: 'Synthetic Device', statement_or_summary: 'Summary',
};
const response = (results, total = results.length) => ({ meta: { results: { total } }, results });
const otherCodes = [{ error: { code: 'NOT_FOUND' } }, response([]), response([])];

test('公开请求限制在计划的来源、字段、市场和日期', () => {
  const urls = expectedSources('A', through).map((entry) => new URL(entry.url));
  expect(urls.map((entry) => entry.hostname)).toEqual(Array(4).fill('api.fda.gov'));
  expect(urls[0].searchParams.get('search')).toBe(
    'product_code:LRK AND decision_code:SESE AND decision_date:[20160101 TO 20261125]',
  );
  const ca = expectedSources('C', through).map((entry) => new URL(entry.url));
  expect(ca).toHaveLength(6);
  expect(ca.every((entry) =>
    entry.hostname === 'health-products.canada.ca' && entry.searchParams.get('state') === 'active',
  )).toBe(true);
  const history = expectedSources('C-history', through).map((entry) => new URL(entry.url));
  expect(history).toHaveLength(6);
  expect(history.map(({ pathname }) => pathname)).toEqual(ca.map(({ pathname }) => pathname));
  expect(history.every((entry) =>
    entry.hostname === 'health-products.canada.ca' && entry.searchParams.get('state') === 'archived',
  )).toBe(true);
  expect(() => expectedSources('C', '2026-02-30')).toThrow('日期无效');
  expect(() => expectedSources('other', through)).toThrow('须为 A 或 C');
});

test('FDA 底稿只把 2026 许可列为候选，逐条核对日期、产品和完整性', () => {
  const earlier = { ...fda, k_number: 'K259999', decision_date: '2025-12-31', statement_or_summary: 'Statement' };
  expect(indexFda([response([fda, fda, earlier]), ...otherCodes], through)).toEqual([
    expect.objectContaining({ id: earlier.k_number, cohort: 'earlier', summary: null }),
    expect.objectContaining({
      id: fda.k_number, cohort: 'candidate-2026',
      summary: 'https://www.accessdata.fda.gov/cdrh_docs/pdf26/K269999.pdf',
    }),
  ]);
  expect(() => indexFda([response([fda], 2), ...otherCodes], through)).toThrow('截断');
  expect(() => indexFda([response([{ ...fda, decision_date: '2026-11-26' }]), ...otherCodes], through)).toThrow('超出查询');
  expect(() => indexFda([response([{ ...fda, product_code: 'LQZ' }]), ...otherCodes], through)).toThrow('超出查询');
  expect(() => indexFda([response([fda, { ...fda, device_name: 'Different' }]), ...otherCodes], through)).toThrow('冲突');
});

const licence = {
  original_licence_no: 99991, licence_name: 'Synthetic CPAP HUMIDIFIER',
  end_date: null, first_licence_status_dt: '2026-04-12', licence_type_cd: 'F',
  company_id: 999, appl_risk_class: 2,
};
const device = {
  original_licence_no: 99991, device_id: 123, first_licence_dt: '2026-04-12',
  trade_name: 'Synthetic Device', end_date: null,
};
const identifier = {
  original_licence_no: 99991, device_id: 123, first_licence_dt: '2026-04-13',
  device_identifier: 'SYNTH', end_date: null,
};

test('MDALL 重复许可合并，按器械和标识的加入日期截断', () => {
  const data = indexMdall([
    [licence, { ...licence, original_licence_no: 99992, first_licence_status_dt: '2026-11-26' }],
    [], [], [licence],
    [device, { ...device, device_id: 124, first_licence_dt: '2026-11-26' }],
    [identifier, { ...identifier, device_identifier: 'LATER', first_licence_dt: '2026-11-26' }],
  ], through);
  expect(data.licences).toEqual([expect.objectContaining({ id: 99991, cohort: 'candidate-2026' })]);
  expect(data.devices).toEqual([expect.objectContaining({ id: 123, licenceId: 99991 })]);
  expect(data.identifiers).toEqual([{ licenceId: 99991, deviceId: 123, value: 'SYNTH', availableOn: '2026-04-13' }]);
});

test('器械编号可以在多张许可复用，标识只连到所属许可', () => {
  const data = indexMdall([
    [licence, { ...licence, original_licence_no: 99992 }], [], [], [],
    [device, { ...device, original_licence_no: 99992 }],
    [identifier, { ...identifier, original_licence_no: 99992, device_identifier: 'SYNTH2' },
      { ...identifier, original_licence_no: 99993, device_identifier: 'OUTSIDE' }],
  ], through);
  expect(data.devices.map(({ licenceId, id }) => [licenceId, id])).toEqual([[99991, 123], [99992, 123]]);
  expect(data.identifiers.map(({ licenceId, value }) => [licenceId, value])).toEqual([
    [99991, 'SYNTH'], [99992, 'SYNTH2'],
  ]);
});

test('历史快照记录取消许可及活动许可上的移除事件，保留许可与器械的组合关系', () => {
  const active = indexMdall([[licence], [], [], [], [device], []], through);
  const archivedLicence = { ...licence, original_licence_no: 99992, licence_status: 'C', end_date: '2026-08-01' };
  const removedActiveDevice = { ...device, device_id: 124, end_date: '2026-08-02' };
  const removedArchivedDevice = { ...device, original_licence_no: 99992, end_date: '2026-07-29' };
  const retiredIdentifiers = [
    { ...identifier, device_id: 124, end_date: '2026-08-02' },
    { ...identifier, device_identifier: 'ALTERNATE', end_date: '2026-08-05' },
    { ...identifier, original_licence_no: 99992, end_date: '2026-07-29' },
    { ...identifier, original_licence_no: 99993, end_date: '2026-07-29' },
    { ...identifier, device_identifier: 'FUTURE', end_date: '2026-11-26' },
  ];
  const result = indexMdallHistory([
    [archivedLicence], [], [], [archivedLicence],
    [removedActiveDevice, removedArchivedDevice], retiredIdentifiers,
  ], through, active);
  expect(result.licences).toEqual([
    expect.objectContaining({
      id: 99992, availableOn: '2026-04-12', endedOn: '2026-08-01',
      status: 'C', type: 'F', riskClass: 2, companyId: 999,
    }),
  ]);
  expect(result.devices.map(({ licenceId, id, endedOn }) => [licenceId, id, endedOn])).toEqual([
    [99991, 124, '2026-08-02'], [99992, 123, '2026-07-29'],
  ]);
  expect(result.identifiers.map(({ licenceId, deviceId, value, endedOn }) =>
    [licenceId, deviceId, value, endedOn],
  )).toEqual([
    [99991, 123, 'ALTERNATE', '2026-08-05'], [99991, 124, 'SYNTH', '2026-08-02'],
    [99992, 123, 'SYNTH', '2026-07-29'],
  ]);
});

test('历史快照拒绝活动数据伪装成移除记录和倒置的日期', () => {
  const active = indexMdall([[licence], [], [], [], [device], []], through);
  expect(() => indexMdallHistory([[], [], [], [], [device], []], through, active))
    .toThrow('历史档案');
  expect(() => indexMdallHistory([
    [{ ...licence, licence_status: 'C', end_date: '2026-04-10' }], [], [], [], [], [],
  ], through, active)).toThrow('日期');
});

test('历史档案离线重算并绑定同一日期的活动档案清单', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cert-board-k14-test-'));
  const activeId = 'C-20261125T185750Z-111111111111';
  const historyId = 'C-history-20261126T030000Z-222222222222';
  const activePayloads = [[licence], [], [], [], [device], [identifier]];
  const historyPayloads = [[], [], [], [], [], [{ ...identifier, end_date: '2026-10-01' }]];
  const active = indexMdall(activePayloads, through);
  const history = indexMdallHistory(historyPayloads, through, active);
  const stringify = (value) => JSON.stringify(value, null, 2) + '\n';
  const sha256 = (value) => createHash('sha256').update(value).digest('hex');

  async function snapshot(id, dataset, payloads, index, counts, binding = {}) {
    const directory = path.join(root, id);
    await mkdir(directory);
    const sources = await Promise.all(expectedSources(dataset, through).map(async (spec, position) => {
      const contents = stringify(payloads[position]);
      await writeFile(path.join(directory, spec.file), contents);
      return {
        ...spec, status: 'saved', httpStatus: 200, receivedAt: '2026-11-26T03:00:00.000Z',
        bytes: Buffer.byteLength(contents), sha256: sha256(contents),
      };
    }));
    await writeFile(path.join(directory, 'index.json'), stringify(index));
    const manifest = stringify({ version: 1, dataset, through, sources, pdfs: [], counts, ...binding });
    await writeFile(path.join(directory, 'manifest.json'), manifest);
    return manifest;
  }

  try {
    const activeManifest = await snapshot(activeId, 'C', activePayloads, active,
      { records: 1, candidates2026: 1, devices: 1, identifiers: 1 });
    await snapshot(historyId, 'C-history', historyPayloads, history,
      { endedLicences: 0, endedDevices: 0, endedIdentifiers: 1 },
      { activeSnapshot: { id: activeId, sha256: sha256(activeManifest) } });
    await expect(loadVerifiedK14(root, historyId)).resolves.toMatchObject({ index: history });

    await writeFile(path.join(root, activeId, 'manifest.json'), activeManifest + '\n');
    await expect(loadVerifiedK14(root, historyId)).rejects.toThrow('清单与历史档案绑定');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
