import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { docReadToolInputSchema, workspaceToolWriteInputSchema } from '@cert-board/shared';
import { readT1Fixture } from '../../documents/t1-seed.js';
import { parseSkillDraftMarkdown } from '../../skills/markdown.js';
import { runAgentKernel } from '../pi/index.js';
import { options, reply, scripted, tool, toolCall } from '../pi/scripted-test-fixture.js';
import { assessR01Timeline } from './r01-timeline.js';

const url = (path: string) => new URL('../../../../../' + path, import.meta.url);
const read = (path: string) => readFileSync(url(path), 'utf8');
const load = (path: string): unknown => JSON.parse(read(path));
const filingExcerpt = new Map(
  [
    ...read('fixtures/official/fda-k253845-pmn-excerpt.txt').matchAll(
      /^(510\(k\) Number|Date Received|Decision Date|Type) ([^\r\n]+)$/gmu,
    ),
  ].map(([, field, value]) => [field, value]),
);
function filingDate(field: 'Date Received' | 'Decision Date') {
  const [month, day, year] = filingExcerpt.get(field)!.split('/');
  return z.iso.date().parse(`${year}-${month}-${day}`);
}

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
    type: filingExcerpt.get('Type'),
    identifier: filingExcerpt.get('510(k) Number'),
    receivedOn: filingDate('Date Received'),
    decidedOn: filingDate('Decision Date'),
  });
  expect(project).toMatchObject({
    k_number: grading.application.identifier,
    decision_date: grading.application.decidedOn,
  });
  for (const [recordUrl, path, queryKey, id] of [
    [
      grading.classificationUrl,
      '/scripts/cdrh/cfdocs/cfpcd/classification.cfm',
      'id',
      designation.product_code,
    ],
    [grading.application.url, '/scripts/cdrh/cfdocs/cfpmn/pmn.cfm', 'ID', project.k_number],
    [grading.candidateUrl, '/scripts/cdrh/cfdocs/cfpmn/pmn.cfm', 'ID', candidate.k_number],
  ] as const) {
    const source = new URL(recordUrl);
    expect(source.protocol).toBe('https:');
    expect(source.hostname).toBe('www.accessdata.fda.gov');
    expect(source.pathname).toBe(path);
    expect(source.searchParams.getAll(queryKey)).toEqual([id]);
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

test.each(['supported', 'swapped', 'invented'] as const)(
  'E23 通过 Agent 剧本读取资料并对实际时间线回执判分 %s',
  async (kind) => {
    const document = '45100000-0000-4000-8000-000000000001';
    const dates = [
      { code: 'sample_made', date: '2030-02-12', text: '合成资料。样品制造日为 2030-02-12。' },
      { code: 'report_issued', date: '2030-03-02', text: '合成资料。报告签发日为 2030-03-02。' },
    ];
    const known = dates.map(({ code, date, text }, index) => ({
      code,
      date,
      state: 'actual' as const,
      source: { kind: 'document' as const, document, page: index + 1, quote: text },
    }));
    const missing = grading.missingDateEvidence.map((code) => ({
      code,
      state: 'missing_evidence' as const,
      date: null,
      source: null,
    }));
    const output = [
      ...(kind === 'swapped'
        ? [
            { ...known[0], code: known[1]!.code },
            { ...known[1], code: known[0]!.code },
          ]
        : known),
      ...(kind === 'invented'
        ? [{ ...known[0], code: missing[0]!.code }, ...missing.slice(1)]
        : missing),
    ];
    const model = scripted([
      reply(
        ...known.map(({ source }) =>
          toolCall('doc_read', JSON.stringify({ id: document, version: 1, page: source.page })),
        ),
      ),
      reply(
        toolCall(
          'ws_write',
          JSON.stringify({
            path: '交付/合成项目时间线.json',
            content: JSON.stringify(output),
            expectedSha256: null,
          }),
        ),
      ),
      reply(toolCall('submit_for_review')),
    ]);
    const received: number[] = [];
    let issues: string[] = ['no_timeline'];
    const result = await runAgentKernel({
      ...options(model.complete, [
        {
          ...tool('doc_read', async (args) => {
            const { id, version, page } = docReadToolInputSchema.parse(args);
            expect(id).toBe(document);
            expect(version).toBe(1);
            expect(page).toBeLessThanOrEqual(2);
            received.push(page);
            return { data: { document, page, text: dates[page - 1]!.text } };
          }),
          parameters: { type: 'object', additionalProperties: true },
        },
        {
          ...tool('ws_write', async (args) => {
            const { content } = workspaceToolWriteInputSchema.parse(args);
            issues = assessR01Timeline(JSON.parse(content), known, grading.missingDateEvidence);
            return { data: { assessed: issues.length === 0 } };
          }),
          parameters: { type: 'object', additionalProperties: true },
        },
        tool('submit_for_review', async () => ({
          data: { ready: issues.length === 0 },
          terminal: 'review',
        })),
      ]),
      messages: [
        { role: 'user', content: '读取合成项目资料并回填实际日期，缺少日期的节点保留待核。' },
      ],
    });
    expect(result.status).toBe('waiting_review');
    expect(received).toEqual([1, 2]);
    if (kind === 'supported') expect(issues).toEqual([]);
    else if (kind === 'swapped')
      expect(issues).toEqual([
        'wrong_date_or_source:sample_made',
        'wrong_date_or_source:report_issued',
      ]);
    else expect(issues).toEqual(['unconfirmed_date:project_started']);
  },
);
