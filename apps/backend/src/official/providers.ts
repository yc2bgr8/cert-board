import { z } from 'zod';
import {
  officialRecordSchema,
  type OfficialLookupInput,
  type OfficialRecord,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';

export const officialPageSize = 25;
type Dataset = OfficialLookupInput['dataset'];
const exactOpenFdaFields = {
  fda_510k: 'k_number',
  fda_classification: 'product_code',
  fda_regulation: 'regulation_number',
  fda_registration: 'registration.registration_number',
  fda_registration_company: 'registration.name.exact',
} as const;

export function officialRequestUrl(input: OfficialLookupInput) {
  if (
    input.asOf &&
    (input.dataset === 'fda_classification' ||
      input.dataset === 'fda_regulation' ||
      input.dataset === 'fda_registration' ||
      input.dataset === 'fda_registration_company' ||
      input.dataset === 'fda_gudid_search' ||
      input.dataset === 'mdall_company_licences')
  )
    throw new AppError(
      409,
      'OFFICIAL_HISTORY_UNAVAILABLE',
      '该官方接口没有可验证的历史版本。请使用截止日期之前的已存档资料。',
    );
  const fda = (key: keyof typeof exactOpenFdaFields, endpoint: string, value: string) => {
    const url = new URL(`https://api.fda.gov/device/${endpoint}.json`);
    const conditions = [`${exactOpenFdaFields[key]}:"${value}"`];
    if (input.dataset === 'fda_registration') {
      if (input.listedProductCode)
        conditions.push(`products.product_code:"${input.listedProductCode}"`);
      if (input.listedKNumber) conditions.push(`k_number:"${input.listedKNumber}"`);
    }
    const exact = conditions.join(' AND ');
    url.searchParams.set(
      'search',
      key === 'fda_510k' && input.asOf
        ? `${exact} AND decision_date:[1976-01-01 TO ${input.asOf}]`
        : exact,
    );
    url.searchParams.set('limit', String(officialPageSize));
    if (input.offset) url.searchParams.set('skip', String(input.offset));
    return url.href;
  };
  const mdall = (resource: string, field: string, value: string) => {
    const url = new URL(`https://health-products.canada.ca/api/medical-devices/${resource}/`);
    url.searchParams.set(field, value);
    url.searchParams.set('type', 'json');
    if (resource === 'licence') url.searchParams.set('lang', 'en');
    if (input.dataset === 'mdall_company_licences' && !input.asOf)
      url.searchParams.set('state', 'active');
    return url.href;
  };
  switch (input.dataset) {
    case 'fda_510k':
      return fda(input.dataset, '510k', input.kNumber);
    case 'fda_classification':
      return fda(input.dataset, 'classification', input.productCode);
    case 'fda_regulation':
      return fda(input.dataset, 'classification', input.regulationNumber);
    case 'fda_registration':
      return fda(input.dataset, 'registrationlisting', input.registrationNumber);
    case 'fda_registration_company':
      return fda(input.dataset, 'registrationlisting', input.companyName);
    case 'fda_gudid_search': {
      const url = new URL('https://api.fda.gov/device/udi.json');
      const matches = (input.brandNames ?? []).map((brand) => `brand_name.exact:"${brand}"`);
      if (input.companyName) matches.push(`company_name.exact:"${input.companyName}"`);
      if (input.kNumber) matches.push(`premarket_submissions.submission_number:"${input.kNumber}"`);
      url.searchParams.set(
        'search',
        `product_codes.code.exact:"${input.productCode}" AND (${matches.join(' OR ')})`,
      );
      url.searchParams.set('limit', String(officialPageSize));
      if (input.offset) url.searchParams.set('skip', String(input.offset));
      return url.href;
    }
    case 'gudid_device': {
      const url = new URL('https://accessgudid.nlm.nih.gov/api/v2/devices/lookup.json');
      url.searchParams.set('di', input.deviceIdentifier);
      return url.href;
    }
    case 'mdall_company_licences':
      return mdall('licence', 'company_id', input.companyId);
    case 'mdall_licence':
      return mdall('licence', 'id', input.licenceNumber);
    case 'mdall_device':
      return mdall('device', 'id', input.deviceId);
    case 'mdall_identifier':
      return mdall('deviceidentifier', 'device_identifier', input.deviceIdentifier);
  }
}

const date = z.iso.date();
const openFdaEmpty = z.object({
  error: z.object({ code: z.literal('NOT_FOUND'), message: z.literal('No matches found!') }),
});
const id = z
  .union([z.number().int().nonnegative().safe(), z.string()])
  .transform(String)
  .pipe(z.string().regex(/^\d{1,12}$/u));
const text = z.string().trim().min(1).max(1000);
const nullableText = z.union([text, z.literal(''), z.null()]).optional();
const optionalDate = z.union([date, z.literal(''), z.null()]).optional();
const classification = z.object({
  product_code: text,
  regulation_number: nullableText,
  device_class: nullableText,
  device_name: nullableText,
});
const fdaEnvelope = z.object({
  meta: z.object({ results: z.object({ total: z.number().int().nonnegative().safe() }) }),
  results: z.array(z.unknown()).max(officialPageSize),
});
const clearance = z.object({
  k_number: text,
  decision_date: date,
  product_code: text,
  device_name: nullableText,
  applicant: nullableText,
  openfda: z.object({ regulation_number: nullableText, device_class: nullableText }).optional(),
});
const registration = z.object({
  registration: z.object({
    registration_number: z.union([id, z.literal(''), z.null()]).optional(),
    fei_number: z.union([id, z.literal(''), z.null()]).optional(),
    name: nullableText,
    reg_expiry_date_year: z.union([text, z.literal(''), z.null()]).optional(),
    status_code: nullableText,
    us_agent: z.object({ business_name: nullableText }).nullish(),
  }),
  k_number: nullableText,
  establishment_type: z.array(text).max(100).optional(),
  proprietary_name: z.array(text).max(1000).optional(),
  products: z
    .array(z.object({ product_code: nullableText }))
    .max(1000)
    .optional(),
});
const fdaGUDID = z.object({
  record_key: text,
  brand_name: nullableText,
  company_name: nullableText,
  public_version_date: optionalDate,
  product_codes: z.array(z.object({ code: text })).max(100),
  premarket_submissions: z
    .array(z.object({ submission_number: nullableText }))
    .max(200)
    .optional(),
  identifiers: z
    .array(z.object({ id: text, type: nullableText }))
    .max(200)
    .optional(),
});
const licence = z.object({
  original_licence_no: id,
  company_id: id,
  licence_name: nullableText,
  first_licence_status_dt: optionalDate,
  end_date: optionalDate,
  licence_type_cd: nullableText,
  appl_risk_class: z.union([z.string(), z.number().int()]).transform(String).optional(),
});
const mdallDevice = z.object({
  original_licence_no: id,
  device_id: id,
  first_licence_dt: optionalDate,
  end_date: optionalDate,
  trade_name: nullableText,
});
const mdallIdentifier = mdallDevice.extend({ device_identifier: text });
const gudid = z.object({
  gudid: z.object({
    device: z.object({
      publicVersionDate: z.iso.datetime({ offset: true }),
      brandName: nullableText,
      companyName: nullableText,
      identifiers: z.object({
        identifier: z
          .array(z.object({ deviceId: text }))
          .min(1)
          .max(200),
      }),
    }),
  }),
});
const mdallRows = z.union([
  z.array(z.unknown()).max(2000),
  z.object({ result: z.array(z.unknown()).max(2000) }).transform(({ result }) => result),
  z.looseObject({ original_licence_no: id }).transform((result) => [result]),
]);

const label = (value: string | null | undefined) =>
  value?.slice(0, 240).replace(/[\uD800-\uDBFF]$/u, '') || undefined;
const cfr = (value: string | null | undefined) =>
  value && /^\d{3}\.\d{4}$/u.test(value) ? value : undefined;
const sameIdentifier = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();
const optionalFields = (fields: OfficialRecord) =>
  officialRecordSchema.parse(
    Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
  );

function matchesDate(record: OfficialRecord, asOf?: string) {
  if (!asOf) return true;
  return Boolean(
    record.effectiveDate &&
    record.effectiveDate <= asOf &&
    (!record.endDate || record.endDate > asOf),
  );
}

function rowsForDataset(dataset: Dataset, raw: unknown) {
  if (dataset.startsWith('mdall_')) return { records: mdallRows.parse(raw) };
  if (dataset === 'gudid_device') return { records: [raw] };
  if (openFdaEmpty.safeParse(raw).success) return { records: [], total: 0 };
  const envelope = fdaEnvelope.parse(raw);
  return { records: envelope.results, total: envelope.meta.results.total };
}

function normalizeRecord(input: OfficialLookupInput, raw: unknown): OfficialRecord | null {
  switch (input.dataset) {
    case 'fda_510k': {
      const row = clearance.parse(raw);
      if (row.k_number !== input.kNumber) return null;
      return {
        identifier: row.k_number,
        effectiveDate: row.decision_date,
        name: input.asOf ? undefined : label(row.device_name),
        company: input.asOf ? undefined : label(row.applicant),
        productCode: row.product_code,
        regulationNumber: input.asOf ? undefined : cfr(row.openfda?.regulation_number),
        deviceClass: input.asOf ? undefined : row.openfda?.device_class || undefined,
      };
    }
    case 'fda_classification':
    case 'fda_regulation': {
      const row = classification.parse(raw);
      const regulationNumber = cfr(row.regulation_number);
      if (input.dataset === 'fda_classification' && row.product_code !== input.productCode)
        return null;
      if (input.dataset === 'fda_regulation' && regulationNumber !== input.regulationNumber)
        return null;
      return {
        identifier: row.product_code,
        productCode: row.product_code,
        name: label(row.device_name),
        regulationNumber,
        deviceClass: row.device_class || undefined,
      };
    }
    case 'fda_registration':
    case 'fda_registration_company': {
      const row = registration.parse(raw);
      const { registration_number, fei_number, name, reg_expiry_date_year, us_agent, status_code } =
        row.registration;
      if (
        input.dataset === 'fda_registration_company' &&
        (!name || !sameIdentifier(name, input.companyName))
      )
        return null;
      if (input.dataset === 'fda_registration' && registration_number !== input.registrationNumber)
        return null;
      const requestedCode =
        input.dataset === 'fda_registration' ? input.listedProductCode : undefined;
      const requestedK = input.dataset === 'fda_registration' ? input.listedKNumber : undefined;
      if (requestedK && row.k_number !== requestedK) return null;
      const available = [
        ...new Set(
          row.products
            ?.map(({ product_code }) => product_code)
            .filter((code): code is string => typeof code === 'string' && /^[A-Z]{3}$/u.test(code)),
        ),
      ];
      if (requestedCode && !available.includes(requestedCode)) return null;
      const listedProductCodes = requestedCode ? [requestedCode] : available.slice(0, 30);
      const names = [
        ...new Set(
          (row.proprietary_name ?? []).map(label).filter((name): name is string => !!name),
        ),
      ];
      const year = Number(reg_expiry_date_year);
      return {
        identifier: registration_number || fei_number || name!.slice(0, 64),
        ...(input.dataset === 'fda_registration_company' && registration_number
          ? { registrationNumber: registration_number }
          : {}),
        company: label(name),
        listedProductCodes: listedProductCodes.length ? listedProductCodes : undefined,
        listedProductCodesTruncated: !requestedCode && available.length > 30 ? true : undefined,
        listedKNumber: row.k_number && /^K\d{6}$/u.test(row.k_number) ? row.k_number : undefined,
        registrationExpiryYear:
          Number.isInteger(year) && year >= 1900 && year <= 2200 ? year : undefined,
        registrationStatusCode:
          status_code && /^\d{1,3}$/u.test(status_code) ? status_code : undefined,
        usAgentBusiness: label(us_agent?.business_name),
        establishmentTypes: row.establishment_type
          ?.slice(0, 15)
          .map(label)
          .filter((item): item is string => !!item),
        proprietaryNames: names.length ? names.slice(0, 30) : undefined,
        proprietaryNamesTruncated: names.length > 30 ? true : undefined,
      };
    }
    case 'fda_gudid_search': {
      const row = fdaGUDID.parse(raw);
      if (!row.product_codes.some(({ code }) => code === input.productCode)) return null;
      const matchesK =
        input.kNumber &&
        row.premarket_submissions?.some(
          ({ submission_number }) => submission_number === input.kNumber,
        );
      const matchesCompany =
        input.companyName &&
        row.company_name &&
        sameIdentifier(row.company_name, input.companyName);
      const brand = row.brand_name;
      const matchesBrand = brand && input.brandNames?.some((name) => sameIdentifier(brand, name));
      if (!matchesK && !matchesCompany && !matchesBrand) return null;
      const primary = row.identifiers?.find(({ type }) => type === 'Primary')?.id;
      return {
        identifier: row.record_key.slice(0, 64),
        gudidRecordKey: label(row.record_key),
        primaryDeviceIdentifier: primary && primary.length <= 64 ? primary : undefined,
        name: label(row.brand_name),
        company: label(row.company_name),
        productCode: input.productCode,
        effectiveDate: row.public_version_date || undefined,
      };
    }
    case 'gudid_device': {
      const row = gudid.parse(raw).gudid.device;
      const match = row.identifiers.identifier.find(({ deviceId }) =>
        sameIdentifier(deviceId, input.deviceIdentifier),
      );
      if (!match) return null;
      if (input.asOf && row.publicVersionDate.slice(0, 10) > input.asOf)
        throw new AppError(
          409,
          'OFFICIAL_HISTORY_UNAVAILABLE',
          '当前器械版本晚于截止日期，请使用该日期以前的公开版本存档。',
        );
      return {
        identifier: match.deviceId,
        name: label(row.brandName),
        company: label(row.companyName),
        effectiveDate: row.publicVersionDate.slice(0, 10),
      };
    }
    case 'mdall_company_licences':
    case 'mdall_licence': {
      const row = licence.parse(raw);
      if (input.dataset === 'mdall_company_licences' && row.company_id !== input.companyId)
        return null;
      if (input.dataset === 'mdall_licence' && row.original_licence_no !== input.licenceNumber)
        return null;
      if (input.dataset === 'mdall_company_licences' && !input.asOf && row.end_date) return null;
      return {
        identifier: row.original_licence_no,
        licenceNumber: row.original_licence_no,
        companyId: input.asOf ? undefined : row.company_id,
        name: input.asOf ? undefined : label(row.licence_name),
        effectiveDate: row.first_licence_status_dt || undefined,
        endDate: row.end_date || undefined,
        licenceType: input.asOf ? undefined : row.licence_type_cd || undefined,
        deviceClass: input.asOf ? undefined : row.appl_risk_class,
      };
    }
    case 'mdall_device': {
      const row = mdallDevice.parse(raw);
      if (row.device_id !== input.deviceId) return null;
      return {
        identifier: row.device_id,
        deviceId: row.device_id,
        licenceNumber: row.original_licence_no,
        name: input.asOf ? undefined : label(row.trade_name),
        effectiveDate: row.first_licence_dt || undefined,
        endDate: row.end_date || undefined,
      };
    }
    case 'mdall_identifier': {
      const row = mdallIdentifier.parse(raw);
      if (!sameIdentifier(row.device_identifier, input.deviceIdentifier)) return null;
      return {
        identifier: row.device_identifier,
        deviceId: row.device_id,
        licenceNumber: row.original_licence_no,
        effectiveDate: row.first_licence_dt || undefined,
        endDate: row.end_date || undefined,
      };
    }
  }
}

export function normalizeOfficialResponse(input: OfficialLookupInput, raw: unknown) {
  const { records, total } = rowsForDataset(input.dataset, raw);
  const filtered = records.flatMap((row) => {
    const normalized = normalizeRecord(input, row);
    if (!normalized || !matchesDate(normalized, input.asOf)) return [];
    if (input.asOf) delete normalized.endDate;
    return [optionalFields(normalized)];
  });
  const strictListing =
    input.dataset === 'fda_registration_company' ||
    input.dataset === 'fda_gudid_search' ||
    (input.dataset === 'fda_registration' && input.listedKNumber !== undefined);
  if (strictListing && records.length && !filtered.length)
    throw new AppError(
      502,
      'OFFICIAL_RESPONSE_UNVERIFIED',
      '返回的公开记录与本次精确查询条件不一致，请核对查询条件或人工复核。',
    );
  const offset = input.offset ?? 0;
  const nextOffset = offset + officialPageSize;
  const hasMore =
    total === undefined
      ? nextOffset < filtered.length
      : nextOffset < total && (!input.asOf || filtered.length === officialPageSize);
  return {
    records: total === undefined ? filtered.slice(offset, nextOffset) : filtered,
    nextOffset: nextOffset <= 1000 && hasMore ? nextOffset : null,
  };
}
