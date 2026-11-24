import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { parseK05Draft, renderK05Draft } from './draft-template.js';

const template = readFileSync(
  new URL('../../../../knowledge/k05/us-510k-cover-letter.yaml', import.meta.url),
  'utf8',
);
const documentId = randomUUID();
const values = {
  submission_type: 'Traditional',
  device_name: 'Synthetic device',
  draft_date: '2030-01-08',
  applicant_name: 'Synthetic applicant',
  applicant_address: 'Synthetic laboratory',
  contact_name: 'Synthetic reviewer',
  contact_email: 'reviewer@example.invalid',
  device_model: 'LAB A',
  product_code: 'ABC',
  submission_purpose: 'Internal drafting exercise',
  comparator_reference: 'Synthetic comparator',
};
const fields = Object.fromEntries(
  Object.entries(values).map(([field, value]) => [
    field,
    { value, source: { documentId, version: 2, page: 3, quote: `合成证据 ${field} ${value}` } },
  ]),
);
const page = Object.values(fields)
  .map(({ source }) => source.quote)
  .join('\n');

test('Cover Letter 草稿逐段记出处，原稿页只读一次，签署保留给人', async () => {
  const read = vi.fn(async () => page);
  const result = await renderK05Draft(template, fields, read);
  expect(read).toHaveBeenCalledOnce();
  expect(result.markdown).toContain('Proposed Traditional 510(k) for Synthetic device.');
  expect(result.markdown).toContain('Submitter to review, sign and date');
  expect(result.sourceMap.publication).toBe('draft');
  expect(result.sourceMap.missing).toEqual([]);
  expect(result.sourceMap.contentSha256).toBe(
    createHash('sha256').update(result.markdown).digest('hex'),
  );
  expect(result.sourceMap.paragraphs).toHaveLength(5);
  expect(result.sourceMap.paragraphs.every(({ sources }) => sources.length > 0)).toBe(true);
  expect(result.sourceMap.paragraphs[0]?.evidence[0]).toMatchObject({
    field: 'submission_type',
    source: { documentId, version: 2, page: 3 },
  });
});

test('缺项在草稿上可见，伪造或跨版本原文拒绝渲染', async () => {
  const result = await renderK05Draft(
    template,
    { device_name: fields.device_name },
    async () => page,
  );
  expect(result.markdown).toContain('[TO VERIFY: submission_type]');
  expect(result.sourceMap.missing).toContain('comparator_reference');
  await expect(renderK05Draft(template, fields, async () => null)).rejects.toThrow('原文不一致');
  await expect(
    renderK05Draft(
      template,
      {
        device_name: { ...fields.device_name!, value: '未经证据支持的名称' },
      },
      async () => page,
    ),
  ).rejects.toThrow('逐字出现');
  expect(() => parseK05Draft(template.replace('[fda_signature_note]', '[missing_source]'))).toThrow(
    '来源引用',
  );
});
