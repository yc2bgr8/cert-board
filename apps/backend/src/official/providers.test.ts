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
  expect(() => officialRequestUrl({ ...company, asOf: '2025-07-03' })).toThrow('历史版本');
  const replay = normalizeOfficialResponse(
    input({ dataset: 'mdall_licence', licenceNumber: '113514', asOf: '2025-07-03' }),
    raw[0],
  ).records;
  expect(replay).toEqual([
    {
      identifier: '113514',
      licenceNumber: '113514',
      effectiveDate: '2025-06-13',
    },
  ]);
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

test('区分 FDA 确认无匹配、网络失败和列名截断', () => {
  const missing = { error: { code: 'NOT_FOUND', message: 'No matches found!' } };
  const approval = input({ dataset: 'fda_510k', kNumber: 'K170825' });
  expect(normalizeOfficialResponse(approval, missing)).toEqual({ records: [], nextOffset: null });
  expect(() =>
    normalizeOfficialResponse(approval, {
      error: { code: 'NOT_FOUND', message: 'endpoint removed' },
    }),
  ).toThrow();
  const products = Array.from({ length: 33 }, (_, index) => ({
    product_code: `A${index < 26 ? 'A' : 'B'}${String.fromCharCode(65 + (index % 26))}`,
  }));
  const query = input({ dataset: 'fda_registration', registrationNumber: '9617474' });
  const payload = {
    meta: { results: { total: 1 } },
    results: [{ registration: { registration_number: '9617474' }, products }],
  };
  const { records } = normalizeOfficialResponse(query, payload);
  expect(records[0]?.listedProductCodes).toHaveLength(30);
  expect(records[0]?.listedProductCodesTruncated).toBe(true);
  const code = products[32]!.product_code;
  const focused = input({ ...query, listedProductCode: code });
  expect(new URL(officialRequestUrl(focused)).searchParams.get('search')).toContain(
    `products.product_code:"${code}"`,
  );
  expect(normalizeOfficialResponse(focused, payload).records[0]?.listedProductCodes).toEqual([
    code,
  ]);
});

test('MDALL 型号保留允许的内部空格和斜线', () => {
  const identifier = 'SPACE-FILL / 6380407';
  const query = input({ dataset: 'mdall_identifier', deviceIdentifier: identifier });
  expect(new URL(officialRequestUrl(query)).searchParams.get('device_identifier')).toBe(identifier);
  expect(
    normalizeOfficialResponse(query, {
      original_licence_no: 12345,
      device_id: 99999,
      device_identifier: identifier,
      first_licence_dt: '2020-01-02',
    }).records,
  ).toMatchObject([{ identifier }]);
});

test('M02 按同一申报号核对列名、注册年度、企业类型和公开代理机构', () => {
  const query = input({
    dataset: 'fda_registration',
    registrationNumber: '1234567890',
    listedKNumber: 'K123456',
    listedProductCode: 'LRK',
  });
  const search = new URL(officialRequestUrl(query)).searchParams.get('search');
  expect(search).toBe(
    'registration.registration_number:"1234567890" AND products.product_code:"LRK" AND k_number:"K123456"',
  );
  const payload = {
    meta: { results: { total: 1 } },
    results: [
      {
        registration: {
          registration_number: '1234567890',
          name: 'Synthetic Company',
          reg_expiry_date_year: '2027',
          status_code: '1',
          us_agent: { business_name: 'Synthetic Agent', email_address: 'fixture@example.invalid' },
        },
        establishment_type: ['Manufacture Medical Device'],
        k_number: 'K123456',
        proprietary_name: ['Example A', 'Example B', 'Example C', 'Example D'],
        products: [{ product_code: 'LRK' }],
      },
    ],
  };
  expect(normalizeOfficialResponse(query, payload).records).toEqual([
    {
      identifier: '1234567890',
      company: 'Synthetic Company',
      listedProductCodes: ['LRK'],
      listedKNumber: 'K123456',
      registrationExpiryYear: 2027,
      registrationStatusCode: '1',
      usAgentBusiness: 'Synthetic Agent',
      establishmentTypes: ['Manufacture Medical Device'],
      proprietaryNames: ['Example A', 'Example B', 'Example C', 'Example D'],
    },
  ]);
  expect(() =>
    normalizeOfficialResponse(input({ ...query, listedKNumber: 'K123457' }), payload),
  ).toThrow('精确查询条件不一致');
});

test('公开公司查询区分未找到和有记录但尚无注册号', () => {
  const company = input({
    dataset: 'fda_registration_company',
    companyName: 'Synthetic Applicant',
  });
  expect(new URL(officialRequestUrl(company)).searchParams.get('search')).toBe(
    'registration.name.exact:"Synthetic Applicant"',
  );
  expect(
    normalizeOfficialResponse(company, {
      error: { code: 'NOT_FOUND', message: 'No matches found!' },
    }).records,
  ).toEqual([]);
  const result = normalizeOfficialResponse(company, {
    meta: { results: { total: 1 } },
    results: [
      {
        registration: {
          name: 'Synthetic Applicant',
          status_code: '5',
          registration_number: '',
          fei_number: '1234567890',
        },
      },
    ],
  });
  expect(result.records).toEqual([
    { identifier: '1234567890', company: 'Synthetic Applicant', registrationStatusCode: '5' },
  ]);
});

test('openFDA 的 GUDID 查询限定公开产品代码和至少一个可复查的识别条件', () => {
  const criteria = input({
    dataset: 'fda_gudid_search',
    productCode: 'LRK',
    kNumber: 'K123456',
    companyName: 'Synthetic Company',
    brandNames: ['Example A'],
  });
  const url = new URL(officialRequestUrl(criteria));
  expect(url.origin).toBe('https://api.fda.gov');
  expect(url.searchParams.get('search')).toBe(
    'product_codes.code.exact:"LRK" AND (brand_name.exact:"Example A" OR company_name.exact:"Synthetic Company" OR premarket_submissions.submission_number:"K123456")',
  );
  const matched = {
    record_key: 'fixture-udi',
    brand_name: 'Example A',
    product_codes: [{ code: 'LRK' }],
    identifiers: [{ type: 'Primary', id: '012345' }],
  };
  const rows = { meta: { results: { total: 1 } }, results: [matched] };
  expect(normalizeOfficialResponse(criteria, rows).records).toEqual([
    {
      identifier: 'fixture-udi',
      gudidRecordKey: 'fixture-udi',
      primaryDeviceIdentifier: '012345',
      name: 'Example A',
      productCode: 'LRK',
    },
  ]);
  expect(
    normalizeOfficialResponse(criteria, { ...rows, results: [{ ...matched, identifiers: [] }] })
      .records,
  ).toEqual([
    {
      identifier: 'fixture-udi',
      gudidRecordKey: 'fixture-udi',
      name: 'Example A',
      productCode: 'LRK',
    },
  ]);
  expect(() =>
    normalizeOfficialResponse(criteria, {
      ...rows,
      results: [{ ...matched, product_codes: [{ code: 'LOM' }] }],
    }),
  ).toThrow('精确查询条件不一致');
  expect(
    normalizeOfficialResponse(criteria, {
      error: { code: 'NOT_FOUND', message: 'No matches found!' },
    }).records,
  ).toEqual([]);
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
