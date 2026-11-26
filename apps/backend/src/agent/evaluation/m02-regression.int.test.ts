import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  checkReportSchema,
  deadlineCalculationResultSchema,
  documentPageReadSchema,
  evaluationStatusViewSchema,
  officialLookupResultSchema,
  reminderResultSchema,
  reviewEvidenceRefSchema,
  skillLoadResultSchema,
  structuredSubmissionSchema,
  workspaceToolReadSchema,
  workspaceToolSaveSchema,
  type DocumentCitation,
  type DocumentPageRead,
  type OfficialLookupInput,
  type StructuredSubmission,
} from '@cert-board/shared';
import { AppError } from '../../api/errors.js';
import { seedDevelopmentBudgetPolicy } from '../../budget/service.js';
import { createTestBlobStore } from '../../documents/test-blob-store.js';
import { verifyM02ListingClaims } from '../../e2e/m02-walkthrough.js';
import { scanM02Schedules } from '../../goals/m02-schedule.js';
import { seedDevelopmentRulePack } from '../../knowledge/rule-packs.js';
import { loadModelGatewayConfig } from '../../modelgw/config.js';
import { ModelGateway } from '../../modelgw/service.js';
import { officialRequestUrl } from '../../official/providers.js';
import { createIntegrationContext } from '../../test-support/context.js';
import { officialLookupTool } from '../../tools/official-lookup.js';
import { seedDevelopmentWorkspace } from '../../workspace/seed.js';
import { buildAgentTools } from '../default-tools.js';
import { executeAgentRun } from '../runtime.js';

const brandNames = [
  'Synthetic Mouthpiece A',
  'Synthetic Mouthpiece B',
  'Synthetic Mouthpiece C',
  'Synthetic Mouthpiece D',
];
const queries = {
  registration: {
    dataset: 'fda_registration',
    registrationNumber: '9000000000',
    listedProductCode: 'LRK',
    listedKNumber: 'K000001',
  },
  applicant: { dataset: 'fda_registration_company', companyName: 'Synthetic Applicant Ltd.' },
  udi: { dataset: 'fda_gudid_search', productCode: 'LRK', brandNames, kNumber: 'K000001' },
} satisfies Record<string, OfficialLookupInput>;
const listingPayload = {
  meta: { results: { total: 1 } },
  results: [
    {
      registration: {
        registration_number: queries.registration.registrationNumber,
        name: 'Synthetic Listing Establishment',
        reg_expiry_date_year: '2027',
        us_agent: { business_name: 'Synthetic US Agent' },
      },
      k_number: queries.registration.listedKNumber,
      proprietary_name: brandNames,
      products: [{ product_code: queries.registration.listedProductCode }],
    },
  ],
};
const udiRecordKey = '00000000-0000-4000-8000-000000000010';
const primaryDeviceIdentifier = '00000000000001';
const udiPayload = {
  meta: { results: { total: 1 } },
  results: [
    {
      public_device_record_key: udiRecordKey,
      public_version_date: '2025-09-29',
      brand_name: brandNames[0],
      product_codes: [{ code: 'LRK' }],
      identifiers: [{ id: primaryDeviceIdentifier, type: 'Primary' }],
    },
  ],
};
const calculation = {
  startDate: '2027-10-01',
  quantity: 91,
  unit: 'calendar_days',
  jurisdictionTz: 'America/New_York',
};
const emptyPayload = { meta: { results: { total: 0 } }, results: [] };
const path = '交付/合成年检核查.md';
type UdiCase = 'matched' | 'zero' | 'unavailable';
type Claim = StructuredSubmission['claims'][number];

function cite(read: DocumentPageRead, field: string): DocumentCitation {
  const start = read.text.indexOf(`"${field}":`);
  expect(start).toBeGreaterThanOrEqual(0);
  const quote =
    field === 'proprietaryNames'
      ? read.text.slice(start, read.text.indexOf(']', start) + 1)
      : read.text.slice(start).split('\n', 1)[0]!.replace(/,$/u, '');
  return { documentId: read.documentId, version: read.version, page: read.page, quote };
}

function claim(
  id: string,
  field: string,
  value: string | number,
  sources: DocumentCitation[] = [],
): Claim {
  return {
    id,
    object: '合成年度注册核查',
    field,
    value,
    sources,
    unit: null,
    status: 'unverified',
  };
}

const call = (name: string, args: unknown) => ({ name, args });
function callRead(evidence: { documentId: string; version: number; page: number }) {
  return call('doc_read', {
    id: evidence.documentId,
    version: evidence.version,
    page: evidence.page,
  });
}

function* recordedRun(scenario: UdiCase): Generator<ReturnType<typeof call>, void, unknown> {
  expect(skillLoadResultSchema.parse(yield call('skill_load', { id: 'M02' })).skill.id).toBe('M02');
  yield call('plan_update', {
    steps: [{ title: '核对官方存档并保留待核实项', status: 'running' }],
    progress: '开始核对合成列名、申请人登记和 UDI。',
  });
  yield call('knowledge_get', { kind: 'rule_pack', code: 'us_fda_m02' });
  const listing = officialLookupResultSchema.parse(
    yield call('official_lookup', queries.registration),
  );
  if (listing.status === 'unavailable') throw new Error('M02_SYNTHETIC_LISTING_' + listing.code);
  if (!listing.evidence || listing.records.length !== 1)
    throw new Error('M02_SYNTHETIC_LISTING_MISSING');
  const listingRead = documentPageReadSchema.parse(yield callRead(listing.evidence));
  const claims = [
    claim('listing_company', '列名机构', 'Synthetic Listing Establishment', [
      cite(listingRead, 'company'),
    ]),
    claim('listing_number', '登记号', queries.registration.registrationNumber, [
      cite(listingRead, 'identifier'),
    ]),
    claim('listing_year', '到期年份', '2027', [cite(listingRead, 'registrationExpiryYear')]),
    claim('listing_agent', '美国代理人企业', 'Synthetic US Agent', [
      cite(listingRead, 'usAgentBusiness'),
    ]),
    ...brandNames.map((name, index) =>
      claim(`brand_${index}`, '公开列名商品名', name, [cite(listingRead, 'proprietaryNames')]),
    ),
  ];
  const applicant = officialLookupResultSchema.parse(
    yield call('official_lookup', queries.applicant),
  );
  if (applicant.status !== 'ok' || !applicant.evidence || applicant.records.length !== 0)
    throw new Error('M02_SYNTHETIC_APPLICANT_EXPECTED_ZERO');
  const applicantRead = documentPageReadSchema.parse(yield callRead(applicant.evidence));
  claims.push(
    claim('applicant_lookup', '申请人登记', '本次查询条件下未查到', [
      cite(applicantRead, 'records'),
    ]),
  );

  const udi = officialLookupResultSchema.parse(yield call('official_lookup', queries.udi));
  if (scenario === 'unavailable') {
    expect(udi.status).toBe('unavailable');
  } else {
    if (udi.status !== 'ok' || !udi.evidence) throw new Error('M02_SYNTHETIC_UDI_MISSING');
    const read = documentPageReadSchema.parse(yield callRead(udi.evidence));
    expect(udi.records.length).toBe(scenario === 'matched' ? 1 : 0);
    if (scenario === 'matched') {
      expect(udi.records[0]).toMatchObject({
        gudidRecordKey: udiRecordKey,
        primaryDeviceIdentifier,
      });
      claims.push(
        claim('udi_lookup', '公开 UDI', '本次查询首批匹配 1 条', [cite(read, 'gudidRecordKey')]),
        claim('udi_record_key', 'UDI 记录键', udiRecordKey, [cite(read, 'gudidRecordKey')]),
        claim('udi_primary_di', '主 DI', primaryDeviceIdentifier, [
          cite(read, 'primaryDeviceIdentifier'),
        ]),
      );
    } else {
      claims.push(claim('udi_lookup', '公开 UDI', '本次查询条件下未查到', [cite(read, 'records')]));
    }
  }

  const deadline = deadlineCalculationResultSchema.parse(yield call('deadline_calc', calculation));
  const reminder = reminderResultSchema.parse(
    yield call('reminder_set', {
      title: '年度注册、列名复核及年费待核实',
      profile: 'milestone',
      calculation: deadline.calculation,
    }),
  );
  expect(reminder.dueDate).toBe('2027-12-31');
  yield call('ws_write', {
    path,
    expectedSha256: null,
    content: [
      ...claims.map(({ field, value }) => `${field}：${value}`),
      ...(scenario === 'unavailable' ? ['公开 UDI：本次查询未完成，来源不可用。'] : []),
      '缴费凭证与代理人签署文件待核实。',
    ].join('\n'),
  });
  const { draftVersion } = workspaceToolReadSchema.parse(yield call('ws_read', { path }));
  const saved = workspaceToolSaveSchema.parse(
    yield call('workspace_save', {
      expectedDraftVersion: draftVersion,
      summary: '保存合成年度核查及官方档案引用',
    }),
  );
  const evidence = Array.from(
    new Map(
      claims.flatMap(({ sources }) => sources).map((item) => [JSON.stringify(item), item]),
    ).values(),
  );
  const submission = structuredSubmissionSchema.parse({
    skill: { id: 'M02', version: '0.1.0' },
    workspaceVersion: saved.workspaceVersion,
    conclusion: '本次公开查询仅用于人工核对。',
    claims,
    evidence,
    decisions: [],
    missing: ['缴费凭证', '代理人签署文件'],
    uncertain: [
      '缴费与代理人协议待注册人员核对。',
      ...(scenario === 'unavailable' ? ['UDI 来源不可用，需重新查询。'] : []),
    ],
    nextStep: '请注册人员审核。',
  });
  const check = checkReportSchema.parse(yield call('check_run', submission));
  expect(check.checks.filter(({ status }) => status === 'failed')).toEqual([]);
  expect(check.passed).toBe(true);
  yield call('submit_for_review', submission);
}

test.each(['matched', 'zero', 'unavailable'] as const)(
  'M02 定时唤醒与七维评测保留录制结果和审核出处（%s）',
  async (scenario) => {
    const context = await createIntegrationContext();
    const { pool, projectId, goalId } = context;
    const storage = await createTestBlobStore();
    try {
      await pool.query(
        "UPDATE cert_project SET project_type='maintenance',jurisdiction_tz='America/New_York' WHERE id=$1",
        [projectId],
      );
      await seedDevelopmentWorkspace(pool, storage.store, { NODE_ENV: 'test' });
      await seedDevelopmentBudgetPolicy(pool, 'test');
      await seedDevelopmentRulePack(pool, 'test');
      const owner = await context.login('MEMBER_A');
      const enabled = await context.app.inject({
        method: 'POST',
        url: `/api/goals/${goalId}/m02-schedule`,
        headers: owner.headers,
        payload: { enabled: true, expectedVersion: 0 },
      });
      expect(enabled.statusCode).toBe(200);
      expect(
        (
          await context.app.inject({
            method: 'POST',
            url: '/api/auth/logout',
            headers: owner.headers,
          })
        ).statusCode,
      ).toBe(204);
      expect(await scanM02Schedules(pool, 'test', new Date('2027-09-30T16:00:00Z'))).toBe(1);
      const {
        rows: [run],
      } = await pool.query<{ id: string; trigger_type: string }>(
        'SELECT id,trigger_type FROM run WHERE goal_id=$1',
        [goalId],
      );
      expect(run?.trigger_type).toBe('wakeup');
      const runId = run!.id;
      const payloads = new Map<string, unknown>([
        [officialRequestUrl(queries.registration), listingPayload],
        [officialRequestUrl(queries.applicant), emptyPayload],
        [officialRequestUrl(queries.udi), scenario === 'matched' ? udiPayload : emptyPayload],
      ]);
      const fetched: string[] = [];
      const lookup = officialLookupTool(
        pool,
        storage.store,
        {
          async fetchPage(url) {
            expect(payloads.has(url)).toBe(true);
            fetched.push(url);
            if (scenario === 'unavailable' && url === officialRequestUrl(queries.udi))
              throw new AppError(503, 'FETCH_PROXY_UNAVAILABLE', '合成录制来源不可用。');
            const data = Buffer.from(JSON.stringify(payloads.get(url)));
            return {
              url,
              title: '合成官方回执',
              text: '',
              truncated: false,
              fetchedAt: new Date().toISOString(),
              mediaType: 'application/json',
              sha256: createHash('sha256').update(data).digest('hex'),
              bodyBase64: data.toString('base64'),
            };
          },
        },
        async (ctx, url) => {
          expect(ctx.projectId).toBe(projectId);
          expect(payloads.has(url)).toBe(true);
          return { projectId };
        },
      );
      const models = await loadModelGatewayConfig({ environment: 'development', sourceEnv: {} });
      const scenarioRun = recordedRun(scenario);
      let invalid: unknown;
      const gateway = new ModelGateway(
        pool,
        models,
        {
          kind: 'fixture',
          async send(_model, request) {
            try {
              const last = request.messages.at(-1);
              const next = scenarioRun.next(
                last?.role === 'tool' ? JSON.parse(last.content) : undefined,
              );
              if (next.done) throw new Error('M02_FIXTURE_OVERFLOW');
              const { name, args } = next.value;
              return {
                id: randomUUID(),
                choices: [
                  {
                    index: 0,
                    finish_reason: 'tool_calls',
                    message: {
                      role: 'assistant',
                      content: null,
                      tool_calls: [
                        {
                          id: randomUUID(),
                          type: 'function',
                          function: { name, arguments: JSON.stringify(args) },
                        },
                      ],
                    },
                  },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: 0 },
              };
            } catch (error) {
              invalid = error;
              throw error;
            }
          },
        },
        { environment: 'test' },
      );
      const completed = await executeAgentRun(
        {
          pool,
          store: storage.store,
          models,
          gateway,
          definitions: async (code) => [
            ...(await buildAgentTools(storage.store, code, pool, 'docker')),
            lookup,
          ],
        },
        runId,
      );
      if (invalid) throw invalid;
      expect(completed).toMatchObject({ status: 'waiting', reviewId: expect.any(String) });
      expect(fetched).toEqual([...payloads.keys()]);
      const reviewId = completed.reviewId!;
      const {
        rows: [card],
      } = await pool.query<{ version: number; structured_result: unknown; evidence_refs: unknown }>(
        "SELECT version,structured_result,evidence_refs FROM review_card WHERE id=$1 AND skill_id='M02' AND status='pending'",
        [reviewId],
      );
      const result = structuredSubmissionSchema.parse(card?.structured_result);
      const citations = reviewEvidenceRefSchema.array().parse(card?.evidence_refs);
      const ref = result.claims[0]!.sources[0]!;
      verifyM02ListingClaims(
        {
          identifier: queries.registration.registrationNumber,
          company: 'Synthetic Listing Establishment',
          registrationExpiryYear: 2027,
          usAgentBusiness: 'Synthetic US Agent',
          proprietaryNames: brandNames,
        },
        brandNames,
        ref,
        result.claims,
        citations,
      );
      const udiClaim = result.claims.find(({ id }) => id === 'udi_lookup');
      if (scenario === 'unavailable') {
        expect(udiClaim).toBeUndefined();
        expect(result.uncertain).toContain('UDI 来源不可用，需重新查询。');
      } else {
        expect(udiClaim).toMatchObject({
          status: 'unverified',
          value: scenario === 'matched' ? '本次查询首批匹配 1 条' : '本次查询条件下未查到',
        });
        expect(udiClaim?.sources.length).toBe(1);
      }
      const timers = await pool.query(
        "SELECT due_on::text AS due,jurisdiction_tz AS zone FROM timer WHERE goal_id=$1 AND state='active'",
        [goalId],
      );
      expect(timers.rows).toEqual([{ due: '2027-12-31', zone: 'America/New_York' }]);
      const {
        rows: [evaluation],
      } = await pool.query(
        'SELECT scheme_version AS version,deterministic,semantic,result FROM eval_report WHERE run_id=$1 AND review_id=$2',
        [runId, reviewId],
      );
      const report = evaluationStatusViewSchema.parse(evaluation);
      expect(report.deterministic.dimensions).toMatchObject({
        task_completion: { status: 'passed' },
        answer_quality: { status: 'needs_review' },
        evidence: { status: 'passed' },
        tool_reliability: { status: 'passed' },
        policy: { status: 'passed' },
        efficiency: { status: 'passed' },
        collaboration: { status: 'passed' },
      });
      expect(report.semantic.status).not.toBe('completed');
      const reviewer = await context.login('MEMBER_B');
      const approved = await context.app.inject({
        method: 'POST',
        url: `/api/reviews/${reviewId}/decision`,
        headers: reviewer.headers,
        payload: {
          expectedVersion: card!.version,
          workspaceVersion: result.workspaceVersion,
          requestKey: randomUUID(),
          action: 'approved',
        },
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json().status).toBe('approved');
      expect(
        (await pool.query('SELECT 1 FROM outbound_message WHERE project_id=$1', [projectId]))
          .rowCount,
      ).toBe(0);
    } finally {
      await storage.dispose();
      await context.close();
    }
  },
  45000,
);
