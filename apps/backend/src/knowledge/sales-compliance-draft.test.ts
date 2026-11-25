import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import {
  buildSyntheticSalesComplianceDraft,
  salesSourceKey,
  syntheticSalesSourceManifest,
} from './sales-compliance-draft.js';
import { parseSkillDraftMarkdown } from '../skills/markdown.js';

const folder = new URL('../../../../fixtures/s01/', import.meta.url);
const fixture = JSON.parse(readFileSync(new URL('synthetic-report.json', folder), 'utf8'));
const pages = syntheticSalesSourceManifest.parse(fixture.pages);
const readSource = async (reference: Parameters<typeof salesSourceKey>[0]) => {
  const found = pages.find((page) => salesSourceKey(page) === salesSourceKey(reference));
  return found
    ? {
        subject: found.subject,
        level: found.level,
        readText: async () => readFileSync(new URL(found.bodyFile, folder), 'utf8'),
      }
    : null;
};
const sourceFor = (text: string) => ({
  subject: 'SYNTH-DEVICE',
  level: 'internal' as const,
  readText: async () => text,
});

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
  const report = await buildSyntheticSalesComplianceDraft(request, async () =>
    sourceFor('对象：SYNTH-DEVICE\n有效期截止日：未说明'),
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

test('确认事实和原页分类独立，原页包含其他主体时留待核', async () => {
  const readRestricted = vi.fn(async () => '不能读取');
  const report = await buildSyntheticSalesComplianceDraft(fixture.request, async (ref) =>
    ref.page === 1
      ? { subject: 'SYNTH-DEVICE', level: 'confidential', readText: readRestricted }
      : sourceFor('对象：SYNTH-DEVICE\n对象：ANOTHER-DEVICE\n证照编号：SYNTH-CERT-01'),
  );
  expect(readRestricted).not.toHaveBeenCalled();
  expect(report.issues).toContainEqual({ field: 'device_model', reason: 'not_approved' });
  expect(report.issues).toContainEqual({ field: 'certificate_number', reason: 'source_invalid' });
  expect(report.sources.references).toEqual([]);
});

test('许可键和原页坐标出现歧义时拒绝', async () => {
  const request = structuredClone(fixture.request);
  request.facts[1].fact.id = request.facts[0].fact.id;
  await expect(buildSyntheticSalesComplianceDraft(request, readSource)).rejects.toThrow('重复修订');
  expect(
    syntheticSalesSourceManifest.safeParse([...pages, { ...pages[0], bodyFile: 'other.txt' }])
      .success,
  ).toBe(false);
});

test('未来修订不抢占当前确认值，申报编号与证照编号分别核验', async () => {
  const request = structuredClone(fixture.request);
  const model = request.facts[0].fact;
  const filing = { ...request.facts[1].fact, field: 'submission_number', value: 'SYNTH-FILING-42' };
  filing.evidence.quote = '申报编号：SYNTH-FILING-42';
  request.facts[1].fact = filing;
  request.facts.push({
    level: 'internal',
    fact: {
      ...model,
      id: '48000000-0000-4000-8000-000000000021',
      revision: 2,
      replacesId: model.id,
      validFrom: '2031-01-01T00:00:00Z',
    },
  });
  request.fields = [
    { field: 'device_model' },
    { field: 'submission_number' },
    { field: 'certificate_number' },
  ];
  const result = await buildSyntheticSalesComplianceDraft(request, async (ref) =>
    ref.page === 1 ? readSource(ref) : sourceFor('对象：SYNTH-DEVICE\n申报编号：SYNTH-FILING-42'),
  );
  expect(result.sources.references.map(({ field, revision }) => [field, revision])).toEqual([
    ['device_model', 1],
    ['submission_number', 1],
  ]);
  expect(result.issues).toEqual([{ field: 'certificate_number', reason: 'missing' }]);
});

test('待发放占位文字保留待核', async () => {
  const request = structuredClone(fixture.request);
  request.fields = [{ field: 'certificate_number' }];
  request.facts[1].fact.value = '待发放';
  request.facts[1].fact.evidence.quote = '证照编号：待发放';
  const reader = vi.fn(readSource);
  const result = await buildSyntheticSalesComplianceDraft(request, reader);
  expect(result.sources.references).toEqual([]);
  expect(result.issues).toEqual([{ field: 'certificate_number', reason: 'source_invalid' }]);
  expect(reader).not.toHaveBeenCalled();
});
