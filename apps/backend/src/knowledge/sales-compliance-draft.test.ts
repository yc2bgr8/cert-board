import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { buildSyntheticSalesComplianceDraft } from './sales-compliance-draft.js';
import { parseSkillDraftMarkdown } from '../skills/markdown.js';

const fixture = JSON.parse(
  readFileSync(new URL('../../../../fixtures/s01/synthetic-report.json', import.meta.url), 'utf8'),
);
const readSource = ({
  documentId,
  version,
  page,
}: {
  documentId: string;
  version: number;
  page: number;
}) =>
  Promise.resolve(
    fixture.pages.find(
      (item: { documentId: string; version: number; page: number }) =>
        item.documentId === documentId && item.version === version && item.page === page,
    )?.text ?? null,
  );

test('合规草稿逐条追踪当前确认值，保密、旧版和来稿猜测不进入交付', async () => {
  const reader = vi.fn(readSource);
  const report = await buildSyntheticSalesComplianceDraft(fixture.request, reader);
  expect(report.markdown).toContain('合成演练');
  expect(report.markdown).toContain('SYNTH\\-CP\\-01');
  expect(report.markdown).toContain('SYNTH\\-CERT\\-01');
  expect(report.markdown).not.toMatch(/UNCONFIRMED|PRIVATE|2036|2035/u);
  expect(report.sources.reportSha256).toBe(
    createHash('sha256').update(report.markdown).digest('hex'),
  );
  expect(report.sources.references.map(({ field, source }) => [field, source.page])).toEqual([
    ['device_model', 1],
    ['certificate_number', 2],
  ]);
  expect(JSON.stringify(report.sources)).not.toMatch(/quote|PRIVATE|UNCONFIRMED/u);
  expect(reader).toHaveBeenCalledTimes(2);
  expect(report.issues).toEqual([
    { field: 'certificate_number', reason: 'mismatch' },
    { field: 'standard_number', reason: 'not_approved' },
    { field: 'expiry_date', reason: 'missing' },
    { field: 'market_status', reason: 'missing' },
  ]);
});

test('引用须在实际原页对应完整字段，旧版许可不能用到替换后的记录', async () => {
  const request = structuredClone(fixture.request);
  request.facts[0].fact.value = 'SYNTH-NOT-SUPPORTED';
  const cert = request.facts[1].fact;
  request.facts[1].fact = {
    ...cert,
    id: '48000000-0000-4000-8000-000000000025',
    revision: 2,
    replacesId: cert.id,
  };
  const reader = vi.fn(readSource);
  const report = await buildSyntheticSalesComplianceDraft(request, reader);
  expect(report.sources.references).toEqual([]);
  expect(report.issues).toContainEqual({ field: 'device_model', reason: 'source_invalid' });
  expect(report.issues).toContainEqual({ field: 'certificate_number', reason: 'not_approved' });
  expect(reader).toHaveBeenCalledOnce();
});

test('只接受明确合成的输入，重复事实修订在渲染前拒绝', async () => {
  await expect(
    buildSyntheticSalesComplianceDraft({ ...fixture.request, synthetic: false }, readSource),
  ).rejects.toThrow();
  await expect(
    buildSyntheticSalesComplianceDraft(
      { ...fixture.request, facts: [...fixture.request.facts, fixture.request.facts[0]] },
      readSource,
    ),
  ).rejects.toThrow('重复修订');
});

test('字段含义要求明确日期，授权也不把非日期变成有效期', async () => {
  const request = structuredClone(fixture.request);
  request.fields = [{ field: 'expiry_date' }];
  request.facts = [
    {
      ...request.facts[3],
      fact: {
        ...request.facts[3].fact,
        value: '未说明',
        evidence: { ...request.facts[3].fact.evidence, quote: '有效期截止日：未说明' },
      },
    },
  ];
  const report = await buildSyntheticSalesComplianceDraft(
    request,
    async () => '有效期截止日：未说明',
  );
  expect(report.sources.references).toEqual([]);
  expect(report.issues).toEqual([{ field: 'expiry_date', reason: 'source_invalid' }]);
});

test('S01 登记草稿归维护 Agent 并保留注册人员与销售边界', () => {
  const source = readFileSync(
    new URL('../../../../skills/S01-销售合规报告与证照资料包/SKILL.md', import.meta.url),
    'utf8',
  );
  const draft = parseSkillDraftMarkdown(source);
  expect(draft.metadata).toMatchObject({
    id: 'S01',
    agentCode: 'maintenance',
    evaluation: 'test:s01',
    requiredChecks: ['V1', 'V3'],
  });
  expect(draft.body).toContain('销售人员不登录');
});
