import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { canonicalPublicWebUrl, officialLookupInputSchema } from '@cert-board/shared';
import { normalizeOfficialResponse, officialRequestUrl } from './providers.js';

const input = (value: unknown) => officialLookupInputSchema.parse(value);
const recorded = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../../fixtures/official/${name}.json`, import.meta.url), 'utf8'),
  );

test('录制的 FDA 510(k)、分类与注册响应保持已知官方字段', () => {
  for (const kNumber of ['K253845', 'K170825']) {
    expect(
      normalizeOfficialResponse(
        input({ dataset: 'fda_510k', kNumber }),
        recorded(`fda-${kNumber.toLowerCase()}`),
      ).records,
    ).toMatchObject([
      { identifier: kNumber, productCode: 'LRK', regulationNumber: '872.5570', deviceClass: '2' },
    ]);
  }
  expect(
    normalizeOfficialResponse(
      input({ dataset: 'fda_regulation', regulationNumber: '872.5570' }),
      recorded('fda-classification-lrk'),
    ).records,
  ).toMatchObject([{ identifier: 'LRK', deviceClass: '2' }]);
  expect(
    normalizeOfficialResponse(
      input({ dataset: 'fda_registration', registrationNumber: '9617474' }),
      recorded('fda-registration-example'),
    ).records,
  ).toMatchObject([{ identifier: '9617474' }]);
});

test('录制的 MDALL 支持公司 21 张许可、单器械对象和型号标识列表', () => {
  const company = input({ dataset: 'mdall_company_licences', companyId: '184937' });
  const raw = recorded('mdall-184937');
  expect(normalizeOfficialResponse(company, raw).records).toHaveLength(21);
  const cut = '2025-07-03';
  const replay = normalizeOfficialResponse({ ...company, asOf: cut }, raw).records;
  expect(replay.length).toBeGreaterThan(0);
  expect(replay.length).toBeLessThan(21);
  expect(replay.every((record) => record.effectiveDate! <= cut)).toBe(true);
  expect(
    normalizeOfficialResponse(
      input({ dataset: 'mdall_device', deviceId: '189995' }),
      recorded('mdall-device-example'),
    ).records,
  ).toMatchObject([{ identifier: '189995' }]);
  expect(
    normalizeOfficialResponse(
      input({ dataset: 'mdall_identifier', deviceIdentifier: 'P02-14030' }),
      recorded('mdall-identifier-example'),
    ).records.length,
  ).toBeGreaterThan(0);
});

test('录制的 AccessGUDID 结果保留可证实的版本日期', () => {
  const lookup = input({ dataset: 'gudid_device', deviceIdentifier: '08717648200274' });
  const raw = recorded('gudid-example');
  expect(normalizeOfficialResponse(lookup, raw).records).toMatchObject([
    { identifier: '08717648200274', effectiveDate: '2026-03-03' },
  ]);
  expect(() => normalizeOfficialResponse({ ...lookup, asOf: '2026-03-02' }, raw)).toThrow(
    '版本晚于截止日期',
  );
});

test('官方查询只从结构化标识符构造固定 HTTPS 请求，按决定日过滤', () => {
  const request = input({ dataset: 'fda_510k', kNumber: 'k170825', asOf: '2018-05-03' });
  const location = officialRequestUrl(request);
  const url = new URL(location);
  expect(canonicalPublicWebUrl(location)).toBe(location);
  expect(url.origin + url.pathname).toBe('https://api.fda.gov/device/510k.json');
  expect(url.searchParams.get('search')).toBe(
    'k_number:"K170825" AND decision_date:[1976-01-01 TO 2018-05-03]',
  );
  expect(() => input({ dataset: 'fda_510k', kNumber: 'K170825 OR *' })).toThrow();
  expect(() =>
    input({ dataset: 'fda_510k', kNumber: 'K170825', url: 'https://example.org/' }),
  ).toThrow();
  expect(() =>
    officialRequestUrl(
      input({ dataset: 'fda_classification', productCode: 'LRK', asOf: '2018-05-03' }),
    ),
  ).toThrow('没有可验证的历史版本');
});

test('FDA 只保留精确 K 号和不晚于截止日的决定', () => {
  const request = input({ dataset: 'fda_510k', kNumber: 'K170825', asOf: '2018-05-03' });
  const row = {
    k_number: 'K170825',
    decision_date: '2018-05-03',
    product_code: 'LRK',
    openfda: { device_class: '2', regulation_number: '872.5570' },
  };
  expect(
    normalizeOfficialResponse(request, {
      meta: { results: { total: 3 } },
      results: [row, { ...row, decision_date: '2018-05-04' }, { ...row, k_number: 'K170285' }],
    }),
  ).toEqual({
    records: [
      {
        identifier: 'K170825',
        effectiveDate: '2018-05-03',
        productCode: 'LRK',
      },
    ],
    nextOffset: null,
  });
});

test('MDALL 截止日过滤部分保留同编号的许可历史', () => {
  const request = input({
    dataset: 'mdall_identifier',
    deviceIdentifier: 'A05',
    asOf: '2025-02-07',
  });
  const row = {
    original_licence_no: 64710,
    device_id: 217390,
    device_identifier: 'A05',
    first_licence_dt: '2025-02-07',
    end_date: '2025-02-08',
  };
  expect(
    normalizeOfficialResponse(request, [
      row,
      { ...row, device_id: 217391, first_licence_dt: '2025-02-08' },
      { ...row, device_id: 217392, end_date: '2025-02-07' },
      { ...row, device_identifier: 'A050' },
      { ...row, first_licence_dt: null },
    ]),
  ).toEqual({
    records: [
      {
        identifier: 'A05',
        deviceId: '217390',
        licenceNumber: '64710',
        effectiveDate: '2025-02-07',
      },
    ],
    nextOffset: null,
  });
});
