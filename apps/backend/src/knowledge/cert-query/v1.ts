import type { CertQueryInput, CertQueryResult } from '@cert-board/shared';

type EnabledTemplate = Exclude<CertQueryInput['template'], 'unsupported'>;
type Table = CertQueryResult['rows'][number]['source']['table'];
interface Template {
  method: string;
  units: Record<string, string>;
  table: Table;
  candidate: string;
  subject?: string;
  incomplete?: string;
}

const authority = `
  SELECT a.id, a.version,
    GREATEST(a.data_level, co.data_level, 'internal') AS data_level,
    a.market, a.status, m.code AS model_code, m.status AS model_status,
    co.id AS credential_id, co.version AS credential_version,
    (a.status NOT IN ('sellable','listed') OR COALESCE(
      co.status = 'active' AND co.model_id = a.model_id AND co.market IN (a.market,'US_CA')
      AND (a.status <> 'sellable' OR m.status = 'active')
      AND (co.effective_date IS NULL OR co.effective_date <= p.today)
      AND (co.expiry_kind = 'perpetual' OR co.expiry_date >= p.today), false)) AS supported
  FROM public.market_authorization a JOIN projects p ON p.id = a.project_id
  JOIN public.model m ON m.id = a.model_id
  LEFT JOIN public.credential co ON co.id = a.credential_id
    AND ($1::uuid IS NULL OR co.project_id = $1)
`;
const authorityBasis = `CASE WHEN supported AND status IN ('sellable','listed') THEN
  jsonb_build_object('table','credential','id',credential_id,'version',credential_version) END`;

export const certQueryCatalogV1 = {
  version: '1.0.0',
  available: (environment: string) => environment === 'development' || environment === 'test',
  templates: {
    credentials_expiring: {
      method: '按项目法域的日历日筛选有效且已生效的定期证照，含今天及第 N 天。排除长期有效证照。',
      units: { expiryDate: '法域日期', daysRemaining: '日' },
      table: 'credential',
      candidate: `
        SELECT c.id, c.version, c.data_level, c.expiry_date::text AS sort_key,
          jsonb_build_object('projectCode',p.code,'credentialType',c.credential_type,
            'credentialNumber',c.credential_number,'expiryDate',c.expiry_date,
            'daysRemaining',c.expiry_date - p.today,'jurisdictionTz',p.jurisdiction_tz) AS fields,
          NULL::jsonb AS basis,
          c.status = 'active' AND c.expiry_date BETWEEN p.today AND p.today + $2::int
            AND (c.effective_date IS NULL OR c.effective_date <= p.today) AS matches,
          c.status = 'active' AND c.expiry_kind = 'unknown' AS incomplete
        FROM public.credential c JOIN projects p ON p.id = c.project_id`,
    },
    model_market_status: {
      method:
        '按型号代码列出范围内的台账市场状态，可售或已列名必须有现时有效的对应证照。缺少记录的市场不推断状态。',
      units: {},
      table: 'market_authorization',
      subject: `EXISTS (SELECT 1 FROM projects p
        JOIN public.model m ON m.id = p.model_id WHERE m.code = $2::text)
        OR EXISTS (SELECT 1 FROM candidate)`,
      incomplete: `EXISTS (
        SELECT 1 FROM (VALUES ('US'),('CA')) AS expected(market)
        WHERE ($1::uuid IS NULL OR EXISTS (
          SELECT 1 FROM projects p WHERE p.market::text IN (expected.market,'US_CA')
        )) AND NOT EXISTS (SELECT 1 FROM candidate c WHERE c.sort_key = expected.market)
      )`,
      candidate: `
        SELECT id, version, data_level, market::text AS sort_key,
          jsonb_build_object('modelCode',model_code,'market',market,
            'status',CASE WHEN supported THEN status END) AS fields,
          ${authorityBasis} AS basis, true AS matches, NOT supported AS incomplete
        FROM (${authority}) a WHERE model_code = $2::text`,
    },
    market_sellable_models: {
      method: '只汇总在指定市场标为可售、型号启用并且有对应有效证照的型号。列名本身不计为可售。',
      units: {},
      table: 'market_authorization',
      candidate: `
        SELECT id, version, data_level, model_code AS sort_key,
          jsonb_build_object('modelCode',model_code,'market',market,'status',status) AS fields,
          ${authorityBasis} AS basis, supported AND model_status = 'active' AS matches,
          NOT supported AS incomplete
        FROM (${authority}) a WHERE market = $2::public.cert_market AND status = 'sellable'`,
    },
    overdue_milestones: {
      method: '按项目法域日历日比较，计划日期早于今天且尚未填完成日期，计算逾期天数。',
      units: { plannedDate: '法域日期', daysOverdue: '日' },
      table: 'cert_milestone',
      candidate: `
        SELECT n.id, n.version, n.data_level, n.planned_date::text AS sort_key,
          jsonb_build_object('projectCode',p.code,'milestoneType',n.milestone_type,
            'title',n.title,'plannedDate',n.planned_date,'daysOverdue',p.today - n.planned_date,
            'jurisdictionTz',p.jurisdiction_tz) AS fields,
          NULL::jsonb AS basis, n.planned_date < p.today AND n.completed_date IS NULL AS matches,
          false AS incomplete
        FROM public.cert_milestone n JOIN projects p ON p.id = n.project_id`,
    },
    pending_my_reviews: {
      method: '与「待我处理」的最终审核口径一致，列出当前成员可处理的待审核卡。',
      units: { createdAt: '时间点（UTC）' },
      table: 'review_card',
      candidate: `
        SELECT r.id, r.version, r.data_level,
          to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_key,
          jsonb_build_object('projectCode',p.code,'conversationId',r.conversation_id,
            'status',r.status,'createdAt',
            to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) AS fields,
          NULL::jsonb AS basis, r.status = 'pending' AS matches, false AS incomplete
        FROM public.review_card r JOIN projects p ON p.id = r.project_id`,
    },
  } satisfies Record<EnabledTemplate, Template>,
};

export function catalogQuery(template: Template) {
  const hasCoverage =
    template.table === 'review_card'
      ? 'true'
      : `
    EXISTS (SELECT 1 FROM projects) AND NOT EXISTS (
      SELECT 1 FROM projects p WHERE NOT EXISTS (
        SELECT 1 FROM coverage c WHERE c.project_id = p.id AND c.verified_at <= statement_timestamp()
      )
    )`;
  return `WITH projects AS MATERIALIZED (
      SELECT id, code, model_id, market, jurisdiction_tz,
        (statement_timestamp() AT TIME ZONE jurisdiction_tz)::date AS today
      FROM public.cert_project WHERE $1::uuid IS NULL OR id = $1
    ), candidate AS MATERIALIZED (${template.candidate}), coverage AS MATERIALIZED (
      SELECT c.project_id, c.verified_at, c.data_level
      FROM public.cert_query_coverage c JOIN projects p ON p.id = c.project_id
      WHERE c.dataset = '${template.table}'
    ), limited AS (
      SELECT * FROM candidate WHERE matches ORDER BY sort_key,id LIMIT 101
    )
    SELECT statement_timestamp() AS "asOf", (${hasCoverage}) AS "hasCoverage",
      (${template.subject ?? 'true'}) AS "hasSubject",
      EXISTS (SELECT 1 FROM candidate WHERE incomplete) OR (${template.incomplete ?? 'false'}) AS incomplete,
      EXISTS (SELECT 1 FROM candidate WHERE data_level = 'confidential')
        OR EXISTS (SELECT 1 FROM coverage WHERE data_level = 'confidential') AS confidential,
      COALESCE((
        SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
          'source',jsonb_build_object('table','${template.table}','id',id,'version',version),
          'basis',basis
        )) || jsonb_build_object('fields',fields) ORDER BY sort_key,id) FROM limited
      ), '[]'::jsonb) AS rows`;
}
