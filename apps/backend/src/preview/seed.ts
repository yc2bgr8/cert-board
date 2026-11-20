import { createHash } from 'node:crypto';
import { parseBackendConfig, previewSlotForOrigin } from '@cert-board/shared';
import { createDependencies } from '../dependencies.js';
import { BlobStore } from '../documents/blob-store.js';
import { ingestParsedDocument } from '../documents/service.js';

const projectId = '81c152b6-21ed-496e-824f-f718cc47a101';
const goalId = '81c152b6-21ed-496e-824f-f718cc47a102';
const documents = [
  {
    key: 'PREVIEW-M02-REG',
    title: '企业注册内部复核记录（合成）',
    text: '开发走查合成资料。适用期为二〇二六年度。内部档案已登记企业注册记录，尚待与官方记录核对。此记录不是 FDA 查询回执。',
  },
  {
    key: 'PREVIEW-M02-FEE',
    title: '年度付款留存凭据（合成）',
    text: '开发走查合成资料。内部账务已归档二〇二六年度的付款回执。凭据号 WALK-FEE-01。该回执仅用于核查归档条目，不作为真实缴费证明。',
  },
  {
    key: 'PREVIEW-M02-AGENT',
    title: '美国代理人协议签署记录（合成）',
    text: '开发走查合成资料。代理人名称为合成联络机构 A，双方签署页已归档。本例协议覆盖本测试年度。不得向机构或监管对象进行真实联系。',
  },
];

async function main() {
  const config = parseBackendConfig(process.env);
  if (config.NODE_ENV !== 'development' || !previewSlotForOrigin(config.WEB_ORIGIN))
    throw new Error('PREVIEW_SEED_TARGET');
  const resources = createDependencies(config);
  const store = new BlobStore(resources.storage, config.MINIO_BUCKET);
  try {
    const { rows } = await resources.database.query<{ id: string }>(
      "SELECT id FROM app_user WHERE username='zhangsan' AND status='active' AND is_development",
    );
    const owner = rows[0]?.id;
    if (!owner) throw new Error('PREVIEW_SEED_OWNER');
    const brief = await store.put(
      Buffer.from(
        '# L08 年度注册走查\n资料为开发走查用合成档案。核对三类记录、引用原文并送审。不要作真实登记、缴费、期限或签署判断。\n',
      ),
    );
    const db = await resources.database.connect();
    try {
      await db.query('BEGIN');
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('preview-maintenance-seed',0))",
      );
      await db.query(
        `INSERT INTO cert_project(id,name,project_type,market,pathway,owner_user_id)
         VALUES($1,'L08 年度注册（走查示例）','maintenance','US','年度注册',$2)
         ON CONFLICT(id) DO NOTHING`,
        [projectId, owner],
      );
      await db.query(
        `INSERT INTO goal(id,project_id,owner_user_id,title,acceptance_criteria)
         VALUES($1,$2,$3,'核查年度注册归档','使用 M02 核查三类合成维护资料，引用原文并提交人工审核。')
         ON CONFLICT(id) DO NOTHING`,
        [goalId, projectId, owner],
      );
      const workspace =
        (
          await db.query<{ id: string; current_version_id: string | null }>(
            'SELECT id,current_version_id FROM workspace WHERE project_id=$1 FOR UPDATE',
            [projectId],
          )
        ).rows[0] ??
        (
          await db.query<{ id: string; current_version_id: string | null }>(
            'INSERT INTO workspace(project_id) VALUES($1) RETURNING id,current_version_id',
            [projectId],
          )
        ).rows[0]!;
      if (!workspace.current_version_id) {
        const created = (
          await db.query<{ id: string }>(
            `INSERT INTO workspace_version(workspace_id,project_id,number,author_type,summary,data_level)
           VALUES($1,$2,1,'system','建立维护走查说明','internal') RETURNING id`,
            [workspace.id, projectId],
          )
        ).rows[0]!;
        await db.query(
          `INSERT INTO workspace_file(version_id,path,sha256,byte_size,data_level,media_type)
           VALUES($1,'AGENTS.md',$2,$3,'internal','text/markdown')`,
          [created.id, brief.sha256, brief.byteSize],
        );
        await db.query('UPDATE workspace SET current_version_id=$1 WHERE id=$2', [
          created.id,
          workspace.id,
        ]);
      }
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      db.release();
    }
    for (const doc of documents)
      await ingestParsedDocument(resources.database, store, {
        projectId,
        sourceKey: doc.key,
        name: doc.title,
        sourcePath: `walkthrough/${doc.key}.txt`,
        sourceSnapshot: createHash('sha256').update(doc.text).digest('hex'),
        dataLevel: 'internal',
        authorType: 'human',
        pages: [{ pageNumber: 1, text: doc.text, method: 'text', locatorKind: 'physical_page' }],
      });
    console.log('维护走查资料已就绪，共三份合成档案。');
  } finally {
    await resources.close();
  }
}

main().catch(() => {
  console.error('独立预览的维护资料未能初始化，请检查本地配置和数据库。');
  process.exitCode = 1;
});
