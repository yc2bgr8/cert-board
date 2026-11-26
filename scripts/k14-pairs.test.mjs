import { expect, test } from 'vitest';
import { companyRecord, nameCandidates, pairIndex, udiRecords } from './k14-pairs.mjs';

const us = { id: 'K269999', deviceName: 'Ａutoflow 2', applicant: 'Example & Partners, Ltd.' };
const matchingLicence = { id: 40, name: 'VARIOUS DEVICES', companyId: 20 };
const unrelatedLicence = { id: 41, name: 'OTHER LICENCE', companyId: 21 };
const device = { id: 7, licenceId: 40, name: 'AUTOFLOW-2' };
const unrelatedDevice = { ...device, licenceId: 41, name: 'AUTOFLOW 12' };
const identifier = { licenceId: 40, deviceId: 7, value: 'AF-02' };
const ca = {
  licences: [matchingLicence, unrelatedLicence],
  devices: [device, unrelatedDevice],
  identifiers: [identifier, { licenceId: 41, deviceId: 7, value: 'WRONG LICENCE' }],
};

test('器械名归一后按许可和器械编号同时关联型号，保留两地记录待人工核对', () => {
  const result = nameCandidates([us], ca);
  expect(result).toEqual([{
    us, licence: matchingLicence, devices: [device], identifiers: [identifier], licenceNameMatches: false,
  }]);
  const company = companyRecord([{
    company_id: 20, company_name: 'EXAMPLE AND PARTNERS', company_status: 'A',
  }], 20);
  expect(pairIndex(result, new Map([[20, company]]), new Map())).toEqual([{
    ...result[0], company, companyNameMatches: true, udiMatches: [], status: 'pending-review',
  }]);
});

test('只匹配许可名称时保留候选，不能借用其它器械的标识', () => {
  const result = nameCandidates([us], { ...ca, licences: [{ ...unrelatedLicence, name: 'AUTOFLOW 2' }] });
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ licenceNameMatches: true, devices: [], identifiers: [] });
  expect(() => pairIndex(result, new Map(), new Map())).toThrow('公司回执');
  const company = companyRecord({ company_id: 21, company_name: 'Different Company' }, 21);
  expect(pairIndex(result, new Map([[21, company]]), new Map())[0])
    .toMatchObject({ companyNameMatches: false, status: 'pending-review' });
});

test('公司回执必须唯一且编号对应，不能使用无公司名称的结果', () => {
  const company = { company_id: 20, company_name: 'Example' };
  expect(() => companyRecord([company, company], 20)).toThrow('唯一');
  expect(() => companyRecord(company, 21)).toThrow('编号');
  expect(() => companyRecord({ ...company, company_name: ' ' }, 20)).toThrow('编号');
});

const udi = {
  premarket_submissions: [{ submission_number: us.id }], record_key: 'synthetic-001',
  publish_date: '2026-11-01', public_version_date: '2026-11-02',
  version_or_model_number: 'AF-02SU', catalog_number: 'AF02', brand_name: 'AF-02',
};
const udiResponse = (row, total = 1) => ({ results: [row], meta: { results: { total } } });

test('仅保留同一申报编号、时间范围内且无截断的 UDI 回执', () => {
  expect(udiRecords(udiResponse(udi), us.id, '2026-11-25', 200)).toEqual([udi]);
  const { record_key: key, ...remaining } = udi;
  expect(udiRecords(udiResponse({
    ...remaining, public_device_record_key: key,
  }), us.id, '2026-11-25', 200)).toMatchObject([{ record_key: key }]);
  expect(udiRecords({ error: { code: 'NOT_FOUND' } }, us.id, '2026-11-25', 404)).toEqual([]);
  expect(() => udiRecords(udiResponse(udi, 2), us.id, '2026-11-25', 200)).toThrow('完整');
  expect(() => udiRecords(udiResponse(udi), 'K269998', '2026-11-25', 200)).toThrow('编号');
  expect(() => udiRecords(udiResponse(udi), us.id, '2026-11-01', 200)).toThrow('日期');
  expect(() => udiRecords(udiResponse({
    ...udi, public_version_date: '2026-02-30',
  }), us.id, '2026-11-25', 200)).toThrow('日期');
});

test('型号完整匹配，保留确切字段并把 UDI 商品名与料号分开', () => {
  const company = { id: 20, name: 'Example and Partners' };
  const index = pairIndex(nameCandidates([us], ca), new Map([[20, company]]), new Map([[us.id, [udi]]]));
  expect(index[0].udiMatches.map(({ field, value }) => [field, value])).toEqual([
    ['brand_name', 'AF-02'], ['catalog_number', 'AF02'],
  ]);
  expect(index[0].status).toBe('pending-review');
});
