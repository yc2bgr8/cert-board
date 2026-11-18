import { describe, expect, it } from 'vitest';
import { checkReportSchema, documentCitationSchema, structuredSubmissionSchema } from './checks.js';

const id = '10000000-0000-4000-8000-000000000001';
const quote = '  Predicate K170825\r\n e\u0301  ';
const citation = { documentId: id, version: 1, page: 1, quote };
function submission() {
  return {
    skill: { id: 'R09', version: '0.1.0-draft' },
    workspaceVersion: id,
    conclusion: '资料中的编号写法需要人工确认。',
    claims: [
      {
        id: 'c1',
        object: '对比器械',
        field: 'K号',
        value: 'K170825',
        unit: null,
        sources: [citation],
        status: 'checked',
      },
    ],
    evidence: [citation],
    missing: [],
    uncertain: ['正确号码仍需人工确认。'],
    nextStep: '核对两处资料并审核检查记录。',
  };
}
const notRun = ['V2', 'V4', 'V5', 'V6', 'V7', 'V8'];
function report() {
  return {
    passed: true,
    dataLevel: 'internal',
    checks: [
      { code: 'V1', status: 'passed', issues: [] },
      { code: 'V3', status: 'passed', issues: [] },
    ],
    notRun,
    citations: [],
  };
}

describe('结构化提交与检查范围契约', () => {
  it('资料引用与doc_read一致，原始空白及Unicode不在输入边界改变', () => {
    expect(documentCitationSchema.parse(citation)).toEqual(citation);
    const parsed = structuredSubmissionSchema.parse(submission());
    expect(parsed.claims[0]?.value).toBe('K170825');
    expect(parsed.claims[0]?.unit).toBeNull();
    expect(parsed.claims[0]?.sources[0]?.quote).toBe(quote);
    expect(parsed.claims[0]?.sources[0]?.quote).not.toBe(quote.normalize('NFC').trim());
  });
  it('引用不接受草稿路径、workspace来源、versionId或伪造定位信息', () => {
    for (const extra of [
      { path: '草稿/检查记录.md' },
      { workspaceId: id },
      { versionId: id },
      { sourceType: 'workspace' },
      { locatorKind: 'physical_page' },
    ])
      expect(documentCitationSchema.safeParse({ ...citation, ...extra }).success).toBe(false);
    expect(documentCitationSchema.safeParse({ ...citation, documentId: 'D035' }).success).toBe(
      false,
    );
    for (const value of [0, 2147483648, 1.5, '1']) {
      expect(documentCitationSchema.safeParse({ ...citation, version: value }).success).toBe(false);
      expect(documentCitationSchema.safeParse({ ...citation, page: value }).success).toBe(false);
    }
  });
  it('陈述编号独立，引用与总输入有上限，超限拒绝而不静默截断', () => {
    const input = submission();
    expect(
      structuredSubmissionSchema.safeParse({ ...input, claims: [input.claims[0], input.claims[0]] })
        .success,
    ).toBe(false);
    expect(
      structuredSubmissionSchema.safeParse({
        ...input,
        evidence: Array.from({ length: 40 }, () => citation),
      }).success,
    ).toBe(false);
    expect(documentCitationSchema.safeParse({ ...citation, quote: ' ' }).success).toBe(false);
    expect(documentCitationSchema.safeParse({ ...citation, quote: 'x'.repeat(4001) }).success).toBe(
      false,
    );
    expect(structuredSubmissionSchema.safeParse({ ...input, checksPassed: true }).success).toBe(
      false,
    );
  });
  it('数值可被解析以返回未支持原因，但不能宣称V7已执行', () => {
    const input = submission();
    expect(
      structuredSubmissionSchema.safeParse({
        ...input,
        claims: [{ ...input.claims[0], value: 12, unit: 'mm' }],
      }).success,
    ).toBe(true);
    const blocked = {
      ...report(),
      passed: false,
      checks: [
        { code: 'V1', status: 'passed', issues: [] },
        {
          code: 'V3',
          status: 'failed',
          issues: [{ code: 'unsupported_quantity', path: 'claims[0]' }],
        },
      ],
    };
    expect(checkReportSchema.safeParse(blocked).success).toBe(true);
    expect(checkReportSchema.safeParse({ ...blocked, passed: true }).success).toBe(false);
    expect(
      checkReportSchema.safeParse({
        ...report(),
        checks: [
          { code: 'V7', status: 'passed', issues: [] },
          { code: 'V3', status: 'passed', issues: [] },
        ],
      }).success,
    ).toBe(false);
    expect(
      checkReportSchema.safeParse({ ...report(), notRun: ['V2', 'V4', 'V5', 'V6', 'V8'] }).success,
    ).toBe(false);
  });
  it('坏结构只能标为V3失败和V1未执行，错误不能回显未知键名或正文', () => {
    const invalid = {
      ...report(),
      passed: false,
      checks: [
        { code: 'V1', status: 'not_run', issues: [] },
        { code: 'V3', status: 'failed', issues: [{ code: 'schema_invalid', path: 'submission' }] },
      ],
    };
    expect(checkReportSchema.safeParse(invalid).success).toBe(true);
    expect(checkReportSchema.safeParse({ ...invalid, passed: true }).success).toBe(false);
    for (const issue of [
      { code: 'schema_invalid', path: 'submission.private-secret' },
      { code: 'schema_invalid', path: 'submission', message: '原始正文' },
      { code: '原始错误正文', path: 'submission' },
    ]) {
      expect(
        checkReportSchema.safeParse({
          ...invalid,
          checks: [
            { code: 'V1', status: 'not_run', issues: [] },
            { code: 'V3', status: 'failed', issues: [issue] },
          ],
        }).success,
      ).toBe(false);
    }
  });
  it('报告定位来自已授权资料元数据，不重复输出引文，状态不能互相矛盾', () => {
    const located = {
      documentId: id,
      version: 1,
      page: 1,
      sourceKey: 'D001',
      locatorKind: 'extraction_unit',
      method: 'docx',
      ocrScore: null,
    };
    expect(checkReportSchema.safeParse({ ...report(), citations: [located] }).success).toBe(true);
    expect(
      checkReportSchema.safeParse({ ...report(), citations: [{ ...located, quote }] }).success,
    ).toBe(false);
    expect(checkReportSchema.safeParse({ ...report(), passed: false }).success).toBe(false);
    expect(
      checkReportSchema.safeParse({
        ...report(),
        checks: [
          { code: 'V1', status: 'passed', issues: [] },
          { code: 'V1', status: 'passed', issues: [] },
        ],
      }).success,
    ).toBe(false);
  });
});
