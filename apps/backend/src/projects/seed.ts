import { createHash } from 'node:crypto';
import type pg from 'pg';
import { developmentProjectSeedConfigSchema } from '@cert-board/shared';
import { DevelopmentSeedError } from '../db/seed.js';

export const developmentProjectId = 'c1a12d0e-f30e-4c43-91dc-1afcf321be01';
export const developmentGoalId = 'c1a12d0e-f30e-4c43-91dc-1afcf321be02';
const seedKey = 'development:l08:510k:v1';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function seedDevelopmentProject(pool: pg.Pool, environment: Record<string, unknown>) {
  if (!developmentProjectSeedConfigSchema.safeParse(environment).success) {
    throw new DevelopmentSeedError('开发项目种子只允许在development/test运行。');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(20261117, 5)');
    const existing = await client.query<{
      id: string;
      development_seed_key: string | null;
      owner_user_id: string;
    }>(
      'SELECT id, development_seed_key,owner_user_id FROM cert_project WHERE id=$1 OR development_seed_key=$2 FOR UPDATE',
      [developmentProjectId, seedKey],
    );
    if (existing.rowCount) {
      const project = existing.rows[0];
      const goal = await client.query(
        'SELECT id,owner_user_id FROM goal WHERE id=$1 AND project_id=$2 FOR UPDATE',
        [developmentGoalId, developmentProjectId],
      );
      if (
        existing.rowCount !== 1 ||
        project?.id !== developmentProjectId ||
        project.development_seed_key !== seedKey ||
        goal.rowCount !== 1
      ) {
        throw new DevelopmentSeedError(
          '开发项目种子存在编号冲突或不完整记录，请人工核对；未覆盖已有数据。',
        );
      }
      const legacy = await client.query<{ id: string }>(
        "SELECT id FROM app_user WHERE is_development=true AND username IN ('ra','rb','gm','sales','tech')",
      );
      const legacyIds = new Set(legacy.rows.map((row) => row.id));
      if (legacyIds.has(project.owner_user_id) || legacyIds.has(goal.rows[0].owner_user_id)) {
        const replacement = (
          await client.query<{ id: string }>(
            "SELECT id FROM app_user WHERE username='zhangsan' AND is_development=true AND status='active' FOR SHARE",
          )
        ).rows[0];
        if (!replacement)
          throw new DevelopmentSeedError('缺少有效的张三开发账号，未改动旧负责人。');
        for (const item of [
          { table: 'cert_project', id: developmentProjectId, owner: project.owner_user_id },
          { table: 'goal', id: developmentGoalId, owner: goal.rows[0].owner_user_id as string },
        ]) {
          if (!legacyIds.has(item.owner)) continue;
          await client.query(
            `UPDATE ${item.table} SET owner_user_id=$1,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$2`,
            [replacement.id, item.id],
          );
          await client.query(
            "INSERT INTO audit_log(actor_kind,action,target_type,target_id,before_hash,after_hash) VALUES('system','development.owner_migrated',$1,$2,$3,$4)",
            [
              item.table,
              item.id,
              digest({ ownerUserId: item.owner }),
              digest({ ownerUserId: replacement.id }),
            ],
          );
        }
      }
      await client.query('COMMIT');
      return { projectId: developmentProjectId, goalId: developmentGoalId, created: false };
    }
    const owner = (
      await client.query<{ id: string }>(
        "SELECT id FROM app_user WHERE username='zhangsan' AND is_development=true AND status='active' FOR SHARE",
      )
    ).rows[0];
    if (!owner) throw new DevelopmentSeedError('缺少有效的张三开发账号，请先初始化并核对账号。');
    const project = await client.query(
      `INSERT INTO cert_project(id,development_seed_key,name,project_type,market,pathway,owner_user_id,reviewer_user_id,next_action)
       VALUES ($1,$2,'L08 510(k)','registration','US','510(k)',$3,NULL,'核对资料中对比器械K号的写法，结论待人工确认。') RETURNING *`,
      [developmentProjectId, seedKey, owner.id],
    );
    const goal = await client.query(
      `INSERT INTO goal(id,project_id,owner_user_id,title,acceptance_criteria)
       VALUES ($1,$2,$3,'检查L08申报资料中对比器械K号的写法','逐页引用原文，列出写法差异并提交人工审核；不擅自认定正确K号。') RETURNING *`,
      [developmentGoalId, developmentProjectId, owner.id],
    );
    for (const entry of [
      { type: 'cert_project', id: developmentProjectId, row: project.rows[0] },
      { type: 'goal', id: developmentGoalId, row: goal.rows[0] },
    ]) {
      await client.query(
        "INSERT INTO audit_log(actor_kind,action,target_type,target_id,after_hash) VALUES ('system','development.seed',$1,$2,$3)",
        [entry.type, entry.id, digest(entry.row)],
      );
    }
    await client.query('COMMIT');
    return { projectId: developmentProjectId, goalId: developmentGoalId, created: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
