import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { BlobStore } from '../documents/blob-store.js';
import { ingestParsedDocument } from '../documents/service.js';

const sample = [
  { pageNumber: 1, text: '合成的申报封面。对比器械 510(k) 编号 K991731。' },
  { pageNumber: 2, text: '合成的对比表。对比器械 510(k) 编号 K991713。' },
] as const;
export const cursorProbeDoc = 'SYN-CURSOR-R09';

export async function prepareCursorProbe(pool: Pool, blobs: BlobStore) {
  const id = randomUUID();
  const goalId = randomUUID();
  const workspaceId = randomUUID();
  const versionId = randomUUID();
  const owner = await pool.query<{ id: string }>(
    "SELECT id FROM app_user WHERE username='zhangsan' AND is_development AND status='active'",
  );
  assert.ok(owner.rows[0]);
  const ownerId = owner.rows[0].id;
  const brief = await blobs.put(
    Buffer.from(
      '# 合成验收项目\n只用合成资料 SYN-CURSOR-R09 的两页，用 R09 核查写法差异。不要查外网。写成短报告，保留资料编号、版本、页码、逐字引语、不确定性和人工核对建议后提交审核。',
    ),
  );
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query(
      "INSERT INTO cert_project(id,name,project_type,market,pathway,owner_user_id) VALUES($1,'合成 Cursor 验收','registration','US','合成 510(k)',$2)",
      [id, ownerId],
    );
    await tx.query(
      "INSERT INTO goal(id,project_id,owner_user_id,title,acceptance_criteria) VALUES($1,$2,$3,'合成编号核查','读取两页合成资料，核对其中的编号写法并送审。')",
      [goalId, id, ownerId],
    );
    await tx.query('INSERT INTO workspace(id,project_id) VALUES($1,$2)', [workspaceId, id]);
    await tx.query(
      "INSERT INTO workspace_version(id,workspace_id,project_id,number,author_type,summary,data_level) VALUES($1,$2,$3,1,'system','合成说明','internal')",
      [versionId, workspaceId, id],
    );
    await tx.query(
      "INSERT INTO workspace_file(version_id,path,sha256,byte_size,data_level,media_type) VALUES($1,'AGENTS.md',$2,$3,'internal','text/markdown')",
      [versionId, brief.sha256, brief.byteSize],
    );
    await tx.query('UPDATE workspace SET current_version_id=$1 WHERE id=$2', [
      versionId,
      workspaceId,
    ]);
    await tx.query('COMMIT');
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    tx.release();
  }
  await ingestParsedDocument(pool, blobs, {
    projectId: id,
    sourceKey: cursorProbeDoc,
    name: '合成对比器械编号清单',
    sourcePath: 'walkthrough/synthetic-cursor-r09.txt',
    sourceSnapshot: createHash('sha256').update(JSON.stringify(sample)).digest('hex'),
    dataLevel: 'internal',
    authorType: 'human',
    pages: sample.map((item) => ({ ...item, method: 'text', locatorKind: 'physical_page' })),
  });
  return id;
}
