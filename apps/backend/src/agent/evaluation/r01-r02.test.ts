import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { readT1Fixture } from '../../documents/t1-seed.js';
import { parseSkillDraftMarkdown } from '../../skills/markdown.js';

const url = (path: string) => new URL('../../../../../' + path, import.meta.url);
const read = (path: string) => readFileSync(url(path), 'utf8');
const load = (path: string): unknown => JSON.parse(read(path));

const grading = z
  .strictObject({
    purpose: z.string().min(1),
    checkedOn: z.iso.date(),
    classificationUrl: z.url(),
    application: z.strictObject({
      url: z.url(),
      identifier: z.string(),
      type: z.string(),
      receivedOn: z.iso.date(),
      decidedOn: z.iso.date(),
    }),
    candidateUrl: z.url(),
    t1Timeline: z
      .strictObject({
        code: z.string(),
        date: z.iso.date(),
        document: z.string(),
        page: z.number().int().positive(),
        rawQuote: z.string(),
      })
      .array()
      .length(8),
    missingDateEvidence: z.string().array().length(4),
  })
  .parse(load('fixtures/r01-r02/l08-grading-sources.json'));

test('R01 和 R02 均能登记为注册技能草稿，关键写入交现行审核', () => {
  const paths = [
    ['R01', '注册项目立项与倒排计划', 'work_schedule_calculate'],
    ['R02', '分类与申报路径研判', 'official_lookup'],
  ] as const;
  for (const [id, name, tool] of paths) {
    const skill = parseSkillDraftMarkdown(read(`skills/${id}-${name}/SKILL.md`));
    expect(skill.metadata).toMatchObject({
      id,
      agentCode: 'registration',
      requiredChecks: ['V1', 'V3'],
    });
    expect(skill.body).toContain('草稿，待注册人员确认');
    expect(skill.body).toContain(tool);
    expect(skill.body).toContain('审核');
  }
});

test('L08 E01 至 E03 的判分事实与已核官方记录一致', () => {
  const classifier = z.object({
    product_code: z.string(),
    device_class: z.string(),
    regulation_number: z.string(),
  });
  const filing = z.object({
    k_number: z.string(),
    decision_date: z.iso.date(),
    product_code: z.string(),
    device_name: z.string(),
  });
  const records = <T extends z.ZodType>(schema: T, path: string) =>
    z.object({ results: schema.array().length(1) }).parse(load(`fixtures/official/${path}.json`))
      .results[0]!;
  const designation = records(classifier, 'fda-classification-lrk');
  const candidate = records(filing, 'fda-k170825');
  const project = records(filing, 'fda-k253845');
  expect(designation).toEqual({
    product_code: 'LRK',
    device_class: '2',
    regulation_number: '872.5570',
  });
  expect(candidate).toEqual({
    k_number: 'K170825',
    decision_date: '2017-08-18',
    product_code: 'LRK',
    device_name: 'SnoreRx',
  });
  expect(grading.application).toMatchObject({
    type: 'Traditional',
    identifier: project.k_number,
    decidedOn: project.decision_date,
  });
  for (const [recordUrl, id] of [
    [grading.classificationUrl, designation.product_code],
    [grading.application.url, project.k_number],
    [grading.candidateUrl, candidate.k_number],
  ]) {
    const source = new URL(recordUrl!);
    expect(source.hostname).toBe('www.accessdata.fda.gov');
    expect([...source.searchParams.values()]).toContain(id);
  }
});

test('E23 实际节点保留逐页出处，未见证据的节点不填日期', async () => {
  const fixture = await readT1Fixture();
  const rows = new Map(grading.t1Timeline.map((item) => [item.code, item]));
  expect(rows.size).toBe(8);
  for (const { document, page, rawQuote, date } of rows.values()) {
    const actual = fixture.pages.find((entry) => entry.doc === document && entry.page === page);
    expect(actual?.text.includes(rawQuote), `${document} 第 ${page} 页`).toBe(true);
    const spelling = rawQuote.split(/[:\n]/u).at(-1)!.trim();
    const isoNumber = /^(\d{4})[./-](\d{2})[./-](\d{2})$/u.exec(spelling);
    const normalized = isoNumber
      ? isoNumber.slice(1).join('-')
      : new Date(`${spelling.replace('.', ' ')} UTC`).toISOString().slice(0, 10);
    expect(normalized).toBe(date);
  }
  expect(grading.application).toMatchObject({ receivedOn: '2025-12-02', decidedOn: '2026-03-03' });
  expect(grading.missingDateEvidence).toEqual([
    'project_started',
    'sample_sent',
    'payment',
    'draft_report',
  ]);
  expect(grading.missingDateEvidence.some((code) => rows.has(code))).toBe(false);
});
