import type { OfficialRecord, ReviewEvidenceRef, StructuredSubmission } from '@cert-board/shared';
import { expect, test } from 'vitest';
import { verifyM02ListingClaims } from './m02-walkthrough.js';

const lookup = ['SYNTHETIC PRODUCT'];
const record: OfficialRecord = {
  identifier: '54321',
  company: 'Synthetic Product',
  registrationExpiryYear: 2026,
  usAgentBusiness: 'Synthetic Agent',
  proprietaryNames: ['Synthetic Product'],
};
const receipt = { documentId: '398fdc60-6d3b-4484-a7bb-b62b5f75a029', version: 2, page: 1 };
const values = [
  ['列名机构', record.company!, '"company": "Synthetic Product"'],
  ['登记号', record.identifier, '"identifier": "54321"'],
  ['到期年份', String(record.registrationExpiryYear), '"registrationExpiryYear": 2026'],
  ['美国代理人企业', record.usAgentBusiness!, '"usAgentBusiness": "Synthetic Agent"'],
  ['公开列名商品名', record.proprietaryNames![0]!, '"proprietaryNames": ["Synthetic Product"]'],
] as const;
const claims = values.map(([field, value, quote], index) => ({
  object: '合成列名',
  id: `listing_${index}`,
  status: 'unverified' as const,
  unit: null,
  field,
  value,
  sources: [{ ...receipt, quote }],
}));
const review = (items: StructuredSubmission['claims']): ReviewEvidenceRef[] =>
  items.flatMap((claim) => claim.sources.map((source) => ({
    ...source, readInvocationId: '4c3d9967-e645-4eb6-bb0a-b9f4dc9130ec',
  })));

test('列名主张逐字保留回执的商品名和对应页码', () => {
  expect(() => verifyM02ListingClaims(record, lookup, receipt, claims, review(claims))).not.toThrow();
  for (const product of [
    { ...claims[4]!, value: lookup[0]! },
    { ...claims[4]!, sources: [{ ...receipt, page: 2, quote: '"Synthetic Product"' }] },
    { ...claims[4]!, sources: [{ ...receipt, version: 1, quote: '"Synthetic Product"' }] },
    { ...claims[4]!, sources: [{ ...receipt, quote: '"Synthetic Product II"' }] },
    { ...claims[4]!, sources: [{ ...receipt, quote: '"company": "Synthetic Product"' }] },
  ]) {
    const altered = [...claims.slice(0, 4), product];
    expect(() => verifyM02ListingClaims(record, lookup, receipt, altered, review(altered)))
      .toThrow('支持该值的已读档案页');
  }
  expect(() => verifyM02ListingClaims(record, lookup, receipt, claims, review(claims.slice(0, 4))))
    .toThrow('支持该值的已读档案页');
});

test('到期年份以文本送审并逐字引用档案中的数字原文', () => {
  const year = claims[2]!;
  expect(() => verifyM02ListingClaims(record, lookup, receipt, claims, review(claims))).not.toThrow();
  for (const altered of [
    { ...year, value: 2026 },
    { ...year, unit: '年' },
    { ...year, sources: [{ ...receipt, quote: '"registrationExpiryYear": "2026"' }] },
    { ...year, sources: [{ ...receipt, quote: '"registrationExpiryYear": 20260' }] },
  ]) {
    const submission = claims.map((claim) => claim.id === year.id ? altered : claim);
    expect(() => verifyM02ListingClaims(record, lookup, receipt, submission, review(submission)))
      .toThrow('支持该值的已读档案页');
  }
});
