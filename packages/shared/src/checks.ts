import { z } from 'zod';
import { deadlineCalculationSchema } from './deadlines.js';
import { documentLocatorKindSchema, documentPageMethodSchema } from './documents.js';
import { workspaceDataLevelSchema } from './workspace.js';

const id = z.string().uuid('资料、工作区或运行编号无效。');
const integer = z.number().int().min(1).max(2147483647);
const validText = (value: string) => /^[^\uD800-\uDFFF]*$/u.test(value) && !value.includes('\0');
const nonblank = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine((value) => value.trim().length > 0 && validText(value), '内容不能为空或包含无效字符。');
const identifier = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, '陈述、判断或技能编号格式无效。');

export const documentCitationSchema = z
  .object({
    documentId: id,
    version: integer,
    page: integer,
    // 摘录是证据，不能在输入边界 trim 或做 Unicode 规范化。
    quote: nonblank(4000),
  })
  .strict();
export type DocumentCitation = z.infer<typeof documentCitationSchema>;

export const structuredClaimSchema = z
  .object({
    id: identifier,
    object: nonblank(200),
    field: nonblank(200),
    value: z.union([nonblank(2000), z.number().finite()]),
    unit: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .nullable()
      .describe('K号等字符串标识符使用null；非空单位及数值陈述在当前切片不受支持。'),
    sources: z.array(documentCitationSchema).max(8),
    status: z.enum(['checked', 'inferred', 'unverified']),
  })
  .strict();
// 历史存储的严格解析器不补新字段，避免改变已签入审核决定的内容哈希。
export const legacyStructuredSubmissionSchema = z
  .object({
    skill: z
      .object({ id: identifier, version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/) })
      .strict(),
    workspaceVersion: id,
    conclusion: nonblank(2000),
    claims: z.array(structuredClaimSchema).min(1).max(20),
    evidence: z.array(documentCitationSchema).max(40),
    missing: z.array(nonblank(500)).max(20),
    uncertain: z.array(nonblank(500)).max(20),
    nextStep: nonblank(1000),
  })
  .strict()
  .superRefine((submission, context) => {
    if (new Set(submission.claims.map((claim) => claim.id)).size !== submission.claims.length)
      context.addIssue({ code: 'custom', message: '陈述编号不能重复，请给每条陈述分配独立编号。' });
    const references =
      submission.evidence.length +
      submission.claims.reduce((total, claim) => total + claim.sources.length, 0);
    if (references > 40)
      context.addIssue({
        code: 'custom',
        message: '单次检查最多40条引用，请缩小检查批次；不会跳过超限引用。',
      });
    if (JSON.stringify(submission).length > 64000)
      context.addIssue({ code: 'custom', message: '结构化提交过长，请缩小批次并保留必要摘录。' });
  });
export type LegacyStructuredSubmission = z.infer<typeof legacyStructuredSubmissionSchema>;
export const structuredDecisionSchema = z
  .object({
    id: identifier,
    subject: nonblank(200),
    choice: nonblank(2000),
    alternatives: z.array(nonblank(500)).max(8),
    reason: nonblank(2000),
    sources: z.array(documentCitationSchema).min(1, '每项判断至少引用一条实际资料原文。').max(8),
    risk: z.enum(['low', 'high']),
  })
  .strict();
export type StructuredDecision = z.infer<typeof structuredDecisionSchema>;
export const structuredSubmissionSchema = legacyStructuredSubmissionSchema
  .safeExtend({
    claims: z
      .array(
        structuredClaimSchema.safeExtend({
          deadlineCalculation: deadlineCalculationSchema.optional(),
        }),
      )
      .min(1)
      .max(20),
    decisions: z.array(structuredDecisionSchema).max(20),
  })
  .superRefine((submission, context) => {
    if (submission.claims.length + submission.decisions.length > 20)
      context.addIssue({ code: 'custom', message: '单次陈述与判断合计最多20条，请拆分检查批次。' });
    if (
      new Set(submission.decisions.map((decision) => decision.id)).size !==
      submission.decisions.length
    )
      context.addIssue({ code: 'custom', message: '判断编号不能重复，请为每项判断分配独立编号。' });
    const references =
      submission.evidence.length +
      submission.claims.reduce((total, claim) => total + claim.sources.length, 0) +
      submission.decisions.reduce((total, decision) => total + decision.sources.length, 0);
    if (references > 40)
      context.addIssue({
        code: 'custom',
        message: '陈述、判断和依据合计最多40条引用，请缩小批次；不会跳过引用。',
      });
  });
export type StructuredSubmission = z.infer<typeof structuredSubmissionSchema>;
export const checkContextSchema = z.object({ runId: id, userId: id }).strict();

export const checkIssueSchema = z
  .object({
    code: z.enum([
      'schema_invalid',
      'source_unavailable',
      'placeholder_source',
      'quote_mismatch',
      'workspace_version_unavailable',
      'unsupported_quantity',
      'missing_evidence',
      'deadline_mismatch',
      'deadline_invalid',
      'deadline_unstructured',
    ]),
    path: z
      .string()
      .max(80)
      .regex(
        /^(?:submission|workspaceVersion|conclusion|nextStep|claims(?:\[[0-9]{1,2}\])?(?:\.(?:value|unit|sources)(?:\[[0-9]{1,2}\])?)?|decisions(?:\[[0-9]{1,2}\])?(?:\.(?:choice|reason|alternatives|sources)(?:\[[0-9]{1,2}\])?)?|evidence(?:\[[0-9]{1,2}\])?)$/,
        '检查路径必须由程序按固定结构生成。',
      ),
  })
  .strict();
const itemSchema = z
  .object({
    code: z.enum(['V1', 'V3', 'V6']),
    status: z.enum(['passed', 'failed', 'not_run']),
    issues: z.array(checkIssueSchema).max(80),
  })
  .strict()
  .refine(
    (item) => (item.status === 'failed' ? item.issues.length > 0 : item.issues.length === 0),
    '检查状态与问题清单不一致。',
  );
export const checkedCitationSchema = z
  .object({
    documentId: id,
    version: integer,
    page: integer,
    sourceKey: z.string().min(1).max(128),
    locatorKind: documentLocatorKindSchema,
    method: documentPageMethodSchema,
    ocrScore: z.number().finite().min(0).max(1).nullable(),
  })
  .strict();
export const checkReportSchema = z
  .object({
    passed: z.boolean(),
    dataLevel: workspaceDataLevelSchema,
    checks: z.array(itemSchema).min(2).max(3),
    notRun: z.union([
      z.tuple([
        z.literal('V2'),
        z.literal('V4'),
        z.literal('V5'),
        z.literal('V6'),
        z.literal('V7'),
        z.literal('V8'),
      ]),
      z.tuple([
        z.literal('V2'),
        z.literal('V4'),
        z.literal('V5'),
        z.literal('V7'),
        z.literal('V8'),
      ]),
    ]),
    citations: z.array(checkedCitationSchema).max(40),
  })
  .strict()
  .superRefine((report, context) => {
    const codes = new Set(report.checks.map((check) => check.code));
    if (
      codes.size !== report.checks.length ||
      !codes.has('V1') ||
      !codes.has('V3') ||
      codes.has('V6') === (report.notRun as readonly string[]).includes('V6')
    )
      context.addIssue({
        code: 'custom',
        message: 'V1 和 V3 必须报告，期限 V6 不得重复出现或同时列入未执行。',
      });
    if (report.passed !== report.checks.every((check) => check.status === 'passed'))
      context.addIssue({ code: 'custom', message: '整体结果不能与分项检查状态矛盾。' });
    if (report.checks.reduce((total, check) => total + check.issues.length, 0) > 80)
      context.addIssue({ code: 'custom', message: '检查问题清单超过上限，请缩小批次。' });
    if (JSON.stringify(report).length > 32000)
      context.addIssue({ code: 'custom', message: '检查报告超过工具输出上限，请缩小批次。' });
  });
export type CheckReport = z.infer<typeof checkReportSchema>;
