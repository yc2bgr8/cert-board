import { afterAll, beforeAll, expect, test } from 'vitest';
import { certQueryResultSchema } from '@cert-board/shared';
import { createIntegrationContext } from '../test-support/context.js';
import { certQueryTool } from './cert-query.js';
import { ToolRegistry } from './registry.js';

type Context = Awaited<ReturnType<typeof createIntegrationContext>>;
let ctx: Context;
let reader: ToolRegistry;
let modelId: string;
let holderId: string;
let caId: string;
const fixture = '合成台账夹具';
const productionUnsupported = [
  { template: 'credentials_expiring', days: 30 },
  { template: 'model_market_status', modelCode: 'SYNTH-41' },
  { template: 'market_sellable_models', market: 'US' },
  { template: 'overdue_milestones' },
  { template: 'pending_my_reviews' },
];

beforeAll(async () => {
  ctx = await createIntegrationContext();
  reader = new ToolRegistry(ctx.pool, [certQueryTool('test')]);
  holderId = (
    await ctx.pool.query(
      "INSERT INTO legal_entity(name,address,country,type) VALUES ('合成持证人','合成地址','US','external_manufacturer') RETURNING id",
    )
  ).rows[0].id;
  modelId = (
    await ctx.pool.query(
      `WITH p AS (INSERT INTO product(code,name) VALUES ('SYNTH-P41','合成产品') RETURNING id)
      INSERT INTO model(product_id,code,source) SELECT id,'SYNTH-41',$1 FROM p RETURNING id`,
      [fixture],
    )
  ).rows[0].id;
  await ctx.pool.query(
    "UPDATE cert_project SET model_id=$2,jurisdiction_tz='Pacific/Honolulu' WHERE id=$1",
    [ctx.projectId, modelId],
  );
  caId = (
    await ctx.pool.query(
      `INSERT INTO cert_project(name,market,pathway,model_id,owner_user_id,jurisdiction_tz)
      VALUES ('合成加拿大项目','CA','合成路径',$1,$2,'America/Toronto') RETURNING id`,
      [modelId, ctx.userId('MEMBER_B')],
    )
  ).rows[0].id;
});
afterAll(async () => {
  await ctx?.close();
});

async function query(input: unknown, registry = reader) {
  const result = await registry.execute(
    await ctx.run('MEMBER_A', 'read_only'),
    'cert_query',
    input,
  );
  return certQueryResultSchema.parse(result.data);
}

async function verify(dataset: string, ...projectIds: string[]) {
  await ctx.pool.query(
    `INSERT INTO cert_query_coverage(project_id,dataset,source,verified_at)
     SELECT id,$1,$2,statement_timestamp() FROM unnest($3::uuid[]) AS id
     ON CONFLICT (project_id,dataset) DO UPDATE SET verified_at=EXCLUDED.verified_at`,
    [dataset, fixture, projectIds],
  );
}

test('证照以法域日期计算含首尾边界，未知到期造成部分结果，未核验的空表无法回答', async () => {
  const input = { template: 'credentials_expiring', days: 30 };
  expect(await query(input)).toMatchObject({
    status: 'unanswerable',
    gaps: ['coverage_unverified'],
    rows: [],
  });
  await ctx.pool.query(
    `INSERT INTO credential(project_id,model_id,holder_entity_id,owner_user_id,credential_type,
      credential_number,market,status,expiry_kind,expiry_date,source)
     SELECT p.id,$2,$3,$4,'合成证照', v.num,'US',v.status,v.kind,
       (CURRENT_TIMESTAMP AT TIME ZONE p.jurisdiction_tz)::date + v.days,$5
     FROM cert_project p CROSS JOIN (VALUES
       ('SYN-TODAY','active','dated',0),('SYN-EDGE','active','dated',30),
       ('SYN-OUT','active','dated',31),('SYN-PAST','active','dated',-1),('SYN-VOID','revoked','dated',0),
       ('SYN-FOREVER','active','perpetual',NULL),('SYN-UNKNOWN','active','unknown',NULL)
     ) AS v(num,status,kind,days) WHERE p.id=$1`,
    [ctx.projectId, modelId, holderId, ctx.userId('MEMBER_A'), fixture],
  );
  await verify('credential', ctx.projectId);
  const partial = await query(input);
  expect(partial).toMatchObject({
    status: 'partial',
    gaps: ['records_incomplete'],
    units: { daysRemaining: '日' },
  });
  expect(partial.rows.map(({ fields }) => [fields.credentialNumber, fields.daysRemaining])).toEqual(
    [
      ['SYN-TODAY', 0],
      ['SYN-EDGE', 30],
    ],
  );
  await ctx.pool.query(
    "UPDATE credential SET expiry_kind='perpetual',version=2 WHERE credential_number='SYN-UNKNOWN'",
  );
  expect(await query(input)).toMatchObject({ status: 'complete', gaps: [], truncated: false });
});

test('型号跨市场与可售名单逐条验证依据并区分缺少覆盖范围', async () => {
  const model = { template: 'model_market_status', modelCode: 'synth-41', scope: 'department' };
  const sellable = { template: 'market_sellable_models', market: 'US', scope: 'department' };
  expect((await query(model)).status).toBe('unanswerable');
  expect((await query(sellable)).status).toBe('unanswerable');
  const basis = (
    await ctx.pool.query(
      `INSERT INTO credential(project_id,model_id,holder_entity_id,owner_user_id,credential_type,
      credential_number,market,status,expiry_kind,source)
      VALUES ($1,$2,$3,$4,'合成许可','SYN-US-41','US','active','perpetual',$5) RETURNING id`,
      [ctx.projectId, modelId, holderId, ctx.userId('MEMBER_A'), fixture],
    )
  ).rows[0].id;
  await ctx.pool.query(
    `INSERT INTO market_authorization(project_id,model_id,market,status,credential_id,source)
      VALUES ($1,$3,'US','sellable',$4,$5),($2,$3,'CA','not_applied',NULL,$5)`,
    [ctx.projectId, caId, modelId, basis, fixture],
  );
  await verify('market_authorization', ctx.projectId);
  expect(await query(model)).toMatchObject({ status: 'partial', gaps: ['coverage_unverified'] });
  expect(await query(sellable)).toMatchObject({ status: 'partial', gaps: ['coverage_unverified'] });
  await verify('market_authorization', caId);
  const lookup = await query(model);
  expect(lookup.status).toBe('complete');
  expect(lookup.rows.map(({ fields }) => [fields.market, fields.status])).toEqual([
    ['CA', 'not_applied'],
    ['US', 'sellable'],
  ]);
  expect(await query(sellable)).toMatchObject({
    status: 'complete',
    rows: [
      {
        basis: { table: 'credential', id: basis, version: 1 },
        fields: { market: 'US', status: 'sellable' },
      },
    ],
  });
  expect(await query({ ...model, scope: 'project' })).toMatchObject({
    status: 'complete',
    rows: [{ fields: { market: 'US' } }],
  });
  await ctx.pool.query("UPDATE credential SET market='CA',version=2 WHERE id=$1", [basis]);
  expect(await query(model)).toMatchObject({
    status: 'partial',
    gaps: ['records_incomplete'],
    rows: [{ fields: { market: 'CA' } }, { fields: { market: 'US', status: null } }],
  });
  expect(await query(sellable)).toMatchObject({
    status: 'unanswerable',
    gaps: ['records_incomplete'],
    rows: [],
  });
  expect(await query({ ...model, modelCode: 'SYNTH-UNKNOWN' })).toMatchObject({
    status: 'unanswerable',
    gaps: expect.arrayContaining(['subject_unverified']),
  });
});

test('逾期只含未完成且早于今天的节点，超过 100 条报告截断', async () => {
  const input = { template: 'overdue_milestones' };
  expect((await query(input)).status).toBe('unanswerable');
  await verify('cert_milestone', ctx.projectId);
  expect(await query(input)).toMatchObject({ status: 'complete', rows: [] });
  await ctx.pool.query(
    `INSERT INTO cert_milestone(project_id,owner_user_id,milestone_type,title,planned_date,completed_date)
     SELECT p.id,$2,'合成节点','合成节点 '||i,(CURRENT_TIMESTAMP AT TIME ZONE p.jurisdiction_tz)::date
       + CASE WHEN i=102 THEN 0 ELSE -1 END,
       CASE WHEN i=103 THEN (CURRENT_TIMESTAMP AT TIME ZONE p.jurisdiction_tz)::date END
     FROM cert_project p CROSS JOIN generate_series(1,103) AS i WHERE p.id=$1`,
    [ctx.projectId, ctx.userId('MEMBER_A')],
  );
  const result = await query(input);
  expect(result).toMatchObject({ status: 'partial', gaps: ['results_truncated'], truncated: true });
  expect(result.rows).toHaveLength(100);
  expect(result.rows.every(({ fields }) => fields.daysOverdue === 1)).toBe(true);
});

test('待审核系统表可确认空结果，未发布目录对所有模板拒绝执行', async () => {
  expect(await query({ template: 'pending_my_reviews' })).toMatchObject({
    status: 'complete',
    rows: [],
  });
  const production = new ToolRegistry(ctx.pool, [certQueryTool('production')]);
  for (const input of productionUnsupported)
    expect(await query(input, production)).toMatchObject({
      status: 'unanswerable',
      gaps: ['template_unavailable'],
      rows: [],
    });
  expect(await query({ template: 'unsupported' })).toMatchObject({
    status: 'unanswerable',
    gaps: ['template_unavailable'],
  });
});

test('只读角色拒绝写台账和读取账号，查询恢复登记层角色并升级旧回执级别', async () => {
  const tx = await ctx.pool.connect();
  try {
    await tx.query('SET ROLE cert_board_reader');
    await expect(tx.query("UPDATE credential SET status='expired'")).rejects.toMatchObject({
      code: '42501',
    });
    await expect(tx.query('SELECT * FROM app_user')).rejects.toMatchObject({ code: '42501' });
  } finally {
    await tx.query('RESET ROLE');
    tx.release();
  }
  const actor = await ctx.run('MEMBER_A', 'read_only');
  const input = { template: 'credentials_expiring', days: 0 };
  await ctx.pool.query(
    `INSERT INTO credential(project_id,holder_entity_id,owner_user_id,credential_type,credential_number,
      status,expiry_kind,expiry_date,source)
      SELECT id,$2,$3,'合成证照','SYN-CLASSIFY','active','dated',
        (statement_timestamp() AT TIME ZONE jurisdiction_tz)::date,$4 FROM cert_project WHERE id=$1`,
    [ctx.projectId, holderId, ctx.userId('MEMBER_A'), fixture],
  );
  const first = await reader.execute(actor, 'cert_query', input);
  expect(first.dataLevel).toBe('internal');
  await ctx.pool.query(
    "UPDATE credential SET data_level='confidential' WHERE credential_number='SYN-CLASSIFY'",
  );
  const repeated = await reader.execute(actor, 'cert_query', input);
  expect(repeated).toMatchObject({ dataLevel: 'confidential', replayed: true, data: first.data });
});
