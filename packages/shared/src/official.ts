import { z } from 'zod';
import { webArchiveInfoSchema } from './web.js';
import { documentCitationSchema } from './checks.js';

const cutoff = z.iso.date().optional();
const offset = z.number().int().min(0).max(1000).optional();
const digits = z
  .string()
  .trim()
  .regex(/^\d{1,12}$/u);
const kNumber = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^K\d{6}$/u);
const productCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/u);
const regulationNumber = z
  .string()
  .trim()
  .regex(/^\d{3}\.\d{4}$/u);
const deviceIdentifier = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+/-]{0,49}$/u);
const mdallIdentifier = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+ /-]{0,63}$/u);
const publicName = z
  .string()
  .trim()
  .min(2)
  .max(120)
  .regex(/^[^\p{C}\p{Zl}\p{Zp}]+$/u)
  .regex(/[\p{L}\p{N}]/u);
const page = { asOf: cutoff, offset };

export const officialLookupInputSchema = z.discriminatedUnion('dataset', [
  z.strictObject({ dataset: z.literal('fda_510k'), kNumber, ...page }),
  z.strictObject({ dataset: z.literal('fda_classification'), productCode, ...page }),
  z.strictObject({ dataset: z.literal('fda_regulation'), regulationNumber, ...page }),
  z.strictObject({
    dataset: z.literal('fda_registration'),
    registrationNumber: digits,
    listedProductCode: productCode.optional(),
    listedKNumber: kNumber.optional(),
    ...page,
  }),
  z.strictObject({
    dataset: z.literal('fda_registration_company'),
    companyName: publicName,
    ...page,
  }),
  z
    .strictObject({
      dataset: z.literal('fda_gudid_search'),
      productCode,
      kNumber: kNumber.optional(),
      companyName: publicName.optional(),
      brandNames: z.array(publicName).min(1).max(4).optional(),
      ...page,
    })
    .refine(
      (query) =>
        query.kNumber !== undefined ||
        query.companyName !== undefined ||
        query.brandNames !== undefined,
    ),
  z.strictObject({ dataset: z.literal('gudid_device'), deviceIdentifier, ...page }),
  z.strictObject({ dataset: z.literal('mdall_company_licences'), companyId: digits, ...page }),
  z.strictObject({ dataset: z.literal('mdall_licence'), licenceNumber: digits, ...page }),
  z.strictObject({ dataset: z.literal('mdall_device'), deviceId: digits, ...page }),
  z.strictObject({
    dataset: z.literal('mdall_identifier'),
    deviceIdentifier: mdallIdentifier,
    ...page,
  }),
]);
export type OfficialLookupInput = z.infer<typeof officialLookupInputSchema>;

export const officialRecordSchema = z.strictObject({
  identifier: z.string().min(1).max(64),
  name: z.string().min(1).max(240).optional(),
  company: z.string().min(1).max(240).optional(),
  companyId: digits.optional(),
  productCode: productCode.optional(),
  listedProductCodes: z.array(productCode).max(30).optional(),
  listedProductCodesTruncated: z.literal(true).optional(),
  registrationNumber: digits.optional(),
  registrationExpiryYear: z.number().int().min(1900).max(2200).optional(),
  registrationStatusCode: z
    .string()
    .regex(/^\d{1,3}$/u)
    .optional(),
  listedKNumber: kNumber.optional(),
  establishmentTypes: z.array(z.string().min(1).max(240)).max(15).optional(),
  proprietaryNames: z.array(z.string().min(1).max(240)).max(30).optional(),
  proprietaryNamesTruncated: z.literal(true).optional(),
  usAgentBusiness: z.string().min(1).max(240).optional(),
  gudidRecordKey: z.string().min(1).max(240).optional(),
  primaryDeviceIdentifier: z.string().min(1).max(64).optional(),
  regulationNumber: regulationNumber.optional(),
  deviceClass: z.string().max(12).optional(),
  licenceNumber: digits.optional(),
  deviceId: digits.optional(),
  effectiveDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
  licenceType: z.string().max(12).optional(),
});
export type OfficialRecord = z.infer<typeof officialRecordSchema>;

const officialCitation = z.strictObject({
  documentId: z.uuid(),
  version: z.number().int().positive(),
  page: z.literal(1),
  sourceKey: z.string().max(128),
  archive: webArchiveInfoSchema,
});
export const officialLookupResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    records: z.array(officialRecordSchema).max(25),
    fetchedAt: z.iso.datetime({ offset: true }),
    asOf: cutoff,
    nextOffset: z.number().int().positive().max(1000).nullable(),
    evidence: officialCitation.nullable(),
    cached: z.boolean(),
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    code: z.string().regex(/^[A-Z0-9_]{1,80}$/u),
    message: z.string().min(1).max(400),
  }),
]);

const identifierEvidence = documentCitationSchema.extend({
  offset: z.number().int().min(0).max(4_000_000).default(0),
});
const citedIdentifier = z.strictObject({
  identifier: mdallIdentifier,
  evidence: identifierEvidence,
});
export const identifierCheckInputSchema = z.strictObject({
  field: z.enum([
    'k_number',
    'product_code',
    'regulation_number',
    'licence_number',
    'device_identifier',
  ]),
  referenceType: z.enum(['official', 'ledger']),
  observed: citedIdentifier,
  references: z.array(citedIdentifier).min(1).max(6),
});
const identifierLocation = z.strictObject({
  identifier: z.string().min(1).max(64),
  sourceKey: z.string().max(128),
  documentId: z.uuid(),
  version: z.number().int().positive(),
  page: z.number().int().positive(),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const identifierCheckSuccess = z.strictObject({
  status: z.enum(['matched', 'possible_typo', 'different']),
  observed: identifierLocation,
  references: z.array(identifierLocation).min(1).max(6),
  candidates: z
    .array(
      z.strictObject({
        identifier: z.string().max(64),
        edits: z.union([z.literal(1), z.literal(2)]),
      }),
    )
    .max(6),
  guidance: z.string().max(240),
});
export const identifierCheckResultSchema = z.union([
  identifierCheckSuccess,
  z.strictObject({
    status: z.literal('unavailable'),
    code: z.string().regex(/^V2_[A-Z0-9_]{1,64}$/u),
    message: z.string().min(1).max(400),
  }),
]);
