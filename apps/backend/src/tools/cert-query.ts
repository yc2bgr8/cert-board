import {
  certQueryInputSchema,
  certQueryResultSchema,
  type CertQueryInput,
  type CertQueryResult,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { catalogQuery, certQueryCatalogV1 } from '../knowledge/cert-query/v1.js';
import type { ToolDefinition, ToolExecutionContext } from './registry.js';

const maxRows = 100;
const catalog = certQueryCatalogV1;

async function withReader<T>(ctx: ToolExecutionContext, read: () => Promise<T>): Promise<T> {
  await ctx.tx.query('SAVEPOINT cert_query_reader');
  try {
    await ctx.tx.query('SET LOCAL ROLE cert_board_reader');
    await ctx.tx.query("SET LOCAL statement_timeout = '1500ms'");
    return await read();
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '57014')
      throw new AppError(503, 'CERT_QUERY_TIMEOUT', '只读台账查询超时。请缩小到当前项目后重试。');
    throw error;
  } finally {
    // 查询已在低权限角色下完成。回到保存点恢复角色和超时设置，供登记层记账。
    await ctx.tx.query('ROLLBACK TO SAVEPOINT cert_query_reader');
    await ctx.tx.query('RELEASE SAVEPOINT cert_query_reader');
  }
}

type QuerySnapshot = {
  asOf: Date;
  hasSubject: boolean;
  hasCoverage: boolean;
  incomplete: boolean;
  confidential: boolean;
  rows: CertQueryResult['rows'];
};

export function certQueryTool(environment = process.env.NODE_ENV ?? 'production'): ToolDefinition {
  return {
    metadata: {
      name: 'cert_query',
      version: 'builtin-cert-query-v1',
      publication: 'published',
      effect: 'read',
      modes: ['read_only', 'ask', 'full'],
      approvalInAsk: false,
      outputDataLevel: 'dynamic',
      authorizationAction: 'record.read',
      description: {
        purpose:
          '按已登记的固定模板读取证照、市场授权、逾期节点和待审核事项，返回来源、口径及数据缺口。',
        whenToUse:
          '回答指定范围内的证照到期、型号市场状态、市场可售型号、逾期节点或待我审核的问题。',
        avoid:
          '查公开监管数据用 official_lookup，核对资料原文用 doc_read。不确定的台账状态不可猜测或当成完整答复。',
        parameters:
          'template 可为 credentials_expiring（给 days）、model_market_status（给 modelCode）、market_sellable_models（给 US 或 CA 的 market）、overdue_milestones、pending_my_reviews 或 unsupported。scope 默认 project；用户明确问全部门时给 department。',
        example: { template: 'credentials_expiring', scope: 'project', days: 30 },
      },
    },
    inputSchema: certQueryInputSchema,
    outputSchema: certQueryResultSchema,
    async execute(ctx, raw) {
      const input = certQueryInputSchema.parse(raw);
      const scope: CertQueryResult['scope'] =
        input.scope === 'project'
          ? { kind: 'project', projectId: ctx.projectId }
          : { kind: 'department' };
      const template =
        input.template === 'unsupported' ? undefined : catalog.templates[input.template];
      const base = {
        catalogVersion: catalog.version,
        template: input.template,
        scope,
        method: template?.method ?? '当前目录没有匹配的固定模板。',
        units: template?.units ?? {},
      };
      if (
        !template ||
        !catalog.available(environment) ||
        (scope.kind === 'project' && !scope.projectId)
      ) {
        const gap =
          !template || !catalog.available(environment)
            ? 'template_unavailable'
            : 'project_required';
        return {
          dataLevel: 'internal',
          data: {
            ...base,
            status: 'unanswerable',
            asOf: new Date().toISOString(),
            gaps: [gap],
            truncated: false,
            rows: [],
          },
        };
      }
      const args: unknown[] = [scope.kind === 'project' ? scope.projectId : null];
      if (input.template === 'credentials_expiring') args.push(input.days);
      if (input.template === 'model_market_status') args.push(input.modelCode);
      if (input.template === 'market_sellable_models') args.push(input.market);
      const {
        rows: [snapshot],
      } = await withReader(ctx, () => ctx.tx.query<QuerySnapshot>(catalogQuery(template), args));
      if (!snapshot) throw new Error('认证台账缺少查询快照。');
      const truncated = snapshot.rows.length > maxRows;
      const rows = snapshot.rows.slice(0, maxRows);
      const gaps: CertQueryResult['gaps'] = [];
      if (!snapshot.hasSubject) gaps.push('subject_unverified');
      if (!snapshot.hasCoverage) gaps.push('coverage_unverified');
      if (snapshot.incomplete) gaps.push('records_incomplete');
      if (truncated) gaps.push('results_truncated');
      const data: CertQueryResult = {
        ...base,
        status: gaps.length === 0 ? 'complete' : rows.length === 0 ? 'unanswerable' : 'partial',
        asOf: snapshot.asOf.toISOString(),
        gaps,
        truncated,
        rows,
      };
      return { data, dataLevel: snapshot.confidential ? 'confidential' : 'internal' };
    },
    async refreshDataLevel(ctx, cached) {
      const result = certQueryResultSchema.parse(cached);
      if (result.catalogVersion !== catalog.version || !catalog.available(environment))
        throw new AppError(
          409,
          'CERT_QUERY_CATALOG_CHANGED',
          '台账目录版本已变更，请重新查询后使用结果。',
        );
      const projectId = result.scope.kind === 'project' ? result.scope.projectId : null;
      if (result.scope.kind === 'project' && projectId !== ctx.projectId)
        throw new AppError(
          409,
          'CERT_QUERY_SCOPE_CHANGED',
          '台账查询范围已变更，请在当前项目重新查询。',
        );
      if (result.template === 'unsupported' || result.gaps.includes('project_required'))
        return 'internal';
      return readReplayLevel(ctx, result.template, projectId, result.rows);
    },
  };
}

async function readReplayLevel(
  ctx: ToolExecutionContext,
  template: Exclude<CertQueryInput['template'], 'unsupported'>,
  projectId: string | null,
  rows: CertQueryResult['rows'],
) {
  const table = catalog.templates[template].table;
  const refs = rows.flatMap(({ source, basis }) => (basis ? [source, basis] : [source]));
  const credentialBases =
    table === 'market_authorization'
      ? `
    UNION ALL
    SELECT 'credential',c.id,c.version,c.data_level FROM public.credential c
    JOIN public.market_authorization a ON a.credential_id = c.id
    WHERE ($1::uuid IS NULL OR a.project_id = $1)
      AND ($1::uuid IS NULL OR c.project_id = $1)`
      : '';
  const snapshot = await withReader(ctx, () =>
    ctx.tx.query<{ confidential: boolean }>(
      `
    WITH sources AS MATERIALIZED (
      SELECT '${table}' AS "table", id, version, data_level FROM public.${table}
      WHERE $1::uuid IS NULL OR project_id = $1
      ${credentialBases}
    )
    SELECT EXISTS (SELECT 1 FROM sources WHERE data_level = 'confidential')
      OR EXISTS (
        SELECT 1 FROM public.cert_query_coverage
        WHERE dataset = '${table}' AND ($1::uuid IS NULL OR project_id = $1)
          AND data_level = 'confidential'
      )
      OR EXISTS (
        SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS ref("table" text,id uuid,version integer)
        WHERE NOT EXISTS (
          SELECT 1 FROM sources s WHERE s."table" = ref."table" AND s.id = ref.id AND s.version = ref.version
        )
      ) AS confidential`,
      [projectId, JSON.stringify(refs)],
    ),
  );
  return snapshot.rows[0]?.confidential === false ? 'internal' : 'confidential';
}
