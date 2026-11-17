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
    const existing = await client.query<{ id: string; development_seed_key: string | null }>(
      'SELECT id, development_seed_key FROM cert_project WHERE id=$1 OR development_seed_key=$2 FOR UPDATE',
      [developmentProjectId, seedKey],
    );
    if (existing.rowCount) {
      const project = existing.rows[0];
      const goal = await client.query('SELECT id FROM goal WHERE id=$1 AND project_id=$2', [
        developmentGoalId,
        developmentProjectId,
      ]);
      if (
        existing.rowCount !== 1 ||
        project?.id !== developmentProjectId ||
        project.development_seed_key !== seedKey ||
        goal.rowCount !== 1
      ) {
        throw new DevelopmentSeedError('开发项目种子存在编号冲突或不完整记录，请人工核对；未覆盖已有数据。');
      }
      await client.query('COMMIT');
      return { projectId: developmentProjectId, goalId: developmentGoalId, created: false };
    }
    const members = await client.query<{ id: string; username: string }>(
      `SELECT DISTINCT u.id,u.username FROM app_user u JOIN role_binding r ON r.user_id=u.id
       WHERE u.is_development=true AND u.status='active' AND r.scope_type='global'
       AND ((u.username='ra' AND r.role='RA') OR (u.username='rb' AND r.role='RB'))`,
    );
    const owner = members.rows.find((user) => user.username === 'ra');
    const reviewer = members.rows.find((user) => user.username === 'rb');
    if (!owner || !reviewer)
      throw new DevelopmentSeedError('缺少有效的RA/RB开发账号及授权，请先初始化并核对账号。');
    const project = await client.query(
      `INSERT INTO cert_project(id,development_seed_key,name,project_type,market,pathway,owner_user_id,reviewer_user_id,next_action)
       VALUES ($1,$2,'L08 510(k)','registration','US','510(k)',$3,$4,'核对资料中对比器械K号的写法，结论待人工确认。') RETURNING *`,
      [developmentProjectId, seedKey, owner.id, reviewer.id],
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
