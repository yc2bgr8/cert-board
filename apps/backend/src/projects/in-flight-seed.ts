import { createHash } from 'node:crypto';
import type pg from 'pg';
import { developmentProjectSeedConfigSchema, type BackendConfig } from '@cert-board/shared';
import { DevelopmentSeedError } from '../db/seed.js';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import { initializeDevelopmentWorkspace } from '../workspace/seed.js';

const scenarios = [
  {
    projectId: '44000000-0000-4000-8000-000000000001',
    goalId: '44000000-0000-4000-8000-000000000002',
    workspaceId: '44000000-0000-4000-8000-000000000003',
    versionId: '44000000-0000-4000-8000-000000000004',
    key: 'development:synthetic:cpap-in-flight:v1',
    type: 'registration',
    name: '演练｜CPAP 510(k) 准备',
    pathway: '510(k) 路径待确认',
    title: '按合成 CPAP 设计输入核查申报准备缺口',
    acceptance: '交付市场与设计输入缺口清单，保留路径、实际型号和目标日期待确认。',
    nodes: [
      { code: 'inputs', label: '确认产品设计输入、用途和配置', dependsOn: [] },
      { code: 'pathway', label: '拟定路径候选并交审核', dependsOn: ['inputs'] },
      { code: 'evidence', label: '准备证据范围与试验缺口', dependsOn: ['pathway'] },
    ],
  },
  {
    projectId: '44000000-0000-4000-8000-000000000011',
    goalId: '44000000-0000-4000-8000-000000000012',
    workspaceId: '44000000-0000-4000-8000-000000000013',
    versionId: '44000000-0000-4000-8000-000000000014',
    key: 'development:synthetic:l08-maintenance-in-flight:v1',
    type: 'maintenance',
    name: '演练｜L08 年度维护',
    pathway: '年度核查演练',
    title: '核对合成 L08 年度维护事项和证据缺口',
    acceptance: '明确需要哪些注册及列名证据，保留需人工确认的责任主体与实际日期。',
    nodes: [
      { code: 'scope', label: '核对维护范围与责任主体', dependsOn: [] },
      { code: 'source', label: '核对登记、列名及有效原文', dependsOn: ['scope'] },
      { code: 'review', label: '将缺口和下一步交注册人员审核', dependsOn: ['source'] },
    ],
  },
] as const;

type Scenario = (typeof scenarios)[number];
const collision = () =>
  new DevelopmentSeedError('合成在途项目已有冲突或记录不完整。请核对数据，原记录已保留。');

export function requireInFlightSeedTarget(
  config: Pick<
    BackendConfig,
    | 'DATABASE_URL'
    | 'MINIO_ENDPOINT'
    | 'MINIO_PORT'
    | 'MINIO_USE_SSL'
    | 'MINIO_BUCKET'
    | 'NODE_ENV'
    | 'CONTAINER_RUNTIME'
  >,
  onAcceptanceVm: boolean,
) {
  const database = new URL(config.DATABASE_URL);
  if (
    !onAcceptanceVm ||
    !developmentProjectSeedConfigSchema.safeParse(config).success ||
    config.CONTAINER_RUNTIME !== 'host' ||
    database.hostname !== '127.0.0.1' ||
    database.port !== '25432' ||
    database.pathname !== '/cert_board' ||
    config.MINIO_ENDPOINT !== '127.0.0.1' ||
    config.MINIO_PORT !== 29000 ||
    config.MINIO_USE_SSL ||
    config.MINIO_BUCKET !== 'cert-board'
  )
    throw new DevelopmentSeedError('请在独立验收机使用已登记的本地测试数据库和文件存储。');
}

function scenarioFiles(seed: Scenario) {
  const items = seed.nodes.map((node) => ({
    ...node,
    status: 'missing_evidence',
    plannedOn: null,
    actualOn: null,
  }));
  return [
    {
      path: 'AGENTS.md',
      content: `# ${seed.name}\n\n合成开发演练。当前阶段：${seed.title}。验收：${seed.acceptance}\n\n实际公司主体、产品规格、证照和业务日期均待注册人员核对。先用资料读取工具取得原文，最终交付由人通过浏览器审核。\n`,
    },
    {
      path: '计划.md',
      content:
        '# 合成计划\n\n' +
        items.map((item) => `- ${item.label}。计划与实际日期待核。`).join('\n') +
        '\n',
    },
    {
      path: '计划/节点.json',
      content: JSON.stringify({ synthetic: true, nodes: items }, null, 2) + '\n',
      mediaType: 'application/json',
    },
    {
      path: '问题清单.md',
      content: '# 问题清单\n\n- 实际主体、型号、证照和节点日期待注册人员确认。\n',
    },
    {
      path: '决定记录.md',
      content: '# 决定记录\n\n当前工作区为合成演练，实际业务决定待注册人员核对。\n',
    },
  ];
}

async function alreadySeeded(client: pg.PoolClient, store: DocumentBlobStore, seed: Scenario) {
  const project = await client.query<{
    id: string;
    development_seed_key: string;
    project_type: string;
  }>(
    'SELECT id,development_seed_key,project_type FROM cert_project WHERE id=$1 OR development_seed_key=$2 FOR UPDATE',
    [seed.projectId, seed.key],
  );
  if (!project.rowCount) return false;
  const row = project.rows[0];
  if (
    project.rowCount !== 1 ||
    row?.id !== seed.projectId ||
    row.development_seed_key !== seed.key ||
    row.project_type !== seed.type
  )
    throw collision();
  const state = await client.query(
    `SELECT 1 FROM goal g JOIN workspace w ON w.project_id=g.project_id
      JOIN workspace_version initial ON initial.workspace_id=w.id AND initial.id=$4
      JOIN workspace_version current ON current.workspace_id=w.id AND current.id=w.current_version_id
      WHERE g.id=$1 AND g.project_id=$2 AND w.id=$3`,
    [seed.goalId, seed.projectId, seed.workspaceId, seed.versionId],
  );
  if (state.rowCount !== 1) throw collision();
  const initialFiles = await client.query<{
    path: string;
    sha256: string;
    byte_size: string;
    media_type: string;
  }>('SELECT path,sha256,byte_size,media_type FROM workspace_file WHERE version_id=$1', [
    seed.versionId,
  ]);
  const byPath = new Map(initialFiles.rows.map((file) => [file.path, file]));
  for (const entry of scenarioFiles(seed)) {
    const file = byPath.get(entry.path);
    if (!file || file.media_type !== (entry.mediaType ?? 'text/markdown')) throw collision();
    let bytes: Buffer;
    try {
      bytes = await store.get(file.sha256);
    } catch {
      throw new DevelopmentSeedError('合成项目的工作区初版文件不可读取，请核对隔离存储后重试。');
    }
    if (
      bytes.length !== Number(file.byte_size) ||
      createHash('sha256').update(bytes).digest('hex') !== file.sha256
    )
      throw new DevelopmentSeedError('合成项目的工作区初版文件校验不符，请核对隔离存储后重试。');
  }
  return true;
}

export async function seedInFlightDevelopment(
  pool: pg.Pool,
  store: DocumentBlobStore,
  environment: Record<string, unknown>,
) {
  if (!developmentProjectSeedConfigSchema.safeParse(environment).success)
    throw new DevelopmentSeedError('合成在途项目仅可在 development 或 test 环境初始化。');
  const client = await pool.connect();
  const results: { projectId: string; goalId: string; workspaceId: string; created: boolean }[] =
    [];
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(20261125,44)');
    const owner = (
      await client.query<{ id: string }>(
        "SELECT id FROM app_user WHERE username='zhangsan' AND is_development=true AND status='active' FOR SHARE",
      )
    ).rows[0];
    if (!owner) throw new DevelopmentSeedError('请先初始化有效的开发账号。');
    for (const seed of scenarios) {
      const exists = await alreadySeeded(client, store, seed);
      if (!exists) {
        const project = await client.query(
          `INSERT INTO cert_project(id,development_seed_key,name,project_type,market,pathway,owner_user_id,next_action)
           VALUES($1,$2,$3,$4,'US',$5,$6,$7) RETURNING *`,
          [seed.projectId, seed.key, seed.name, seed.type, seed.pathway, owner.id, seed.title],
        );
        const goal = await client.query(
          'INSERT INTO goal(id,project_id,owner_user_id,title,acceptance_criteria) VALUES($1,$2,$3,$4,$5) RETURNING *',
          [seed.goalId, seed.projectId, owner.id, seed.title, seed.acceptance],
        );
        await initializeDevelopmentWorkspace(client, store, {
          projectId: seed.projectId,
          workspaceId: seed.workspaceId,
          versionId: seed.versionId,
          summary: '建立合成在途项目工作区与节点',
          level: 'internal',
          files: scenarioFiles(seed),
        });
        for (const [type, id, row] of [
          ['cert_project', seed.projectId, project.rows[0]],
          ['goal', seed.goalId, goal.rows[0]],
        ]) {
          const hash = createHash('sha256').update(JSON.stringify(row)).digest('hex');
          await client.query(
            "INSERT INTO audit_log(actor_kind,action,target_type,target_id,after_hash) VALUES('system','development.seed',$1,$2,$3)",
            [type, id, hash],
          );
        }
      }
      results.push({
        projectId: seed.projectId,
        goalId: seed.goalId,
        workspaceId: seed.workspaceId,
        created: !exists,
      });
    }
    await client.query('COMMIT');
    return results;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
