import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  requestRetentionPolicySchema,
  syntheticModelRequestSchema,
  requestPurgeOptionsSchema,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';

async function transaction<T>(pool: Pool, operation: (tx: PoolClient) => Promise<T>) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const result = await operation(tx);
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => undefined);
    if (error instanceof AppError) throw error;
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23503')
      throw new AppError(
        403,
        'REQUEST_RETENTION_CONTEXT_MISMATCH',
        '请求、运行与用户归属不一致，已拒绝保留内容。',
      );
    throw new AppError(
      500,
      'REQUEST_RETENTION_FAILED',
      '私有请求保留或清理未完成，请维护人员核对；未输出原文或连接信息。',
    );
  } finally {
    tx.release();
  }
}

/** 默认零保留直接返回，不能先落库再删除；正TTL仅用于隔离测试数据库的合成记录。 */
export async function retainModelRequest(pool: Pool, input: unknown, rawPolicy: unknown) {
  const policy = requestRetentionPolicySchema.safeParse(rawPolicy);
  if (!policy.success)
    throw new AppError(
      400,
      'REQUEST_RETENTION_POLICY_INVALID',
      '保留期限无效，请使用0至30的整数天数。',
    );
  if (policy.data.retentionDays === 0) return { stored: false as const };
  if (policy.data.environment !== 'test' || process.env.NODE_ENV !== 'test')
    throw new AppError(
      403,
      'REQUEST_RETENTION_DISABLED',
      '真实请求正文当前采用零保留；非零期限只用于合成测试。',
    );
  const parsed = syntheticModelRequestSchema.safeParse(input);
  if (!parsed.success)
    throw new AppError(
      400,
      'REQUEST_RETENTION_INPUT_INVALID',
      '合成请求格式无效，只允许身份引用和文本消息，不接受请求头或凭据字段。',
    );
  const data = parsed.data;
  return transaction(pool, async (tx) => {
    const database = await tx.query<{ name: string }>('SELECT current_database() AS name');
    if (!/^cert_[a-f0-9]{24}_test$/.test(database.rows[0]?.name ?? ''))
      throw new AppError(
        403,
        'REQUEST_RETENTION_TEST_DATABASE_REQUIRED',
        '非零保留期限只能在隔离的临时测试库中验证。',
      );
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO model_request_content(request_id,run_id,user_id,content_json,expires_at)
       VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP + make_interval(days => $5::int))
       ON CONFLICT(request_id) DO NOTHING RETURNING id`,
      [data.requestId, data.runId, data.userId, data.content, policy.data.retentionDays],
    );
    if (inserted.rows[0])
      return { stored: true as const, id: inserted.rows[0].id, replayed: false };
    const existing = await tx.query<{ id: string; same: boolean }>(
      'SELECT id,(content_json=$4::jsonb) AS same FROM model_request_content WHERE request_id=$1 AND run_id=$2 AND user_id=$3',
      [data.requestId, data.runId, data.userId, data.content],
    );
    if (!existing.rows[0]?.same)
      throw new AppError(
        409,
        'REQUEST_RETENTION_CONFLICT',
        '同一请求的归属或内容已变化，不能覆盖保留记录。',
      );
    return { stored: true as const, id: existing.rows[0].id, replayed: true };
  });
}

export async function purgeExpiredModelRequests(pool: Pool, rawOptions: unknown = {}) {
  const parsed = requestPurgeOptionsSchema.safeParse(rawOptions);
  if (!parsed.success)
    throw new AppError(
      400,
      'REQUEST_PURGE_OPTIONS_INVALID',
      '清理批量必须为1至1000条，请缩小批量后重试。',
    );
  return transaction(pool, async (tx) => {
    const deleted = await tx.query<{ id: string }>(
      `WITH expired AS (
         SELECT id FROM model_request_content WHERE expires_at<=CURRENT_TIMESTAMP
         ORDER BY expires_at,id LIMIT $1 FOR UPDATE SKIP LOCKED
       ) DELETE FROM model_request_content target USING expired
         WHERE target.id=expired.id RETURNING target.id`,
      [parsed.data.limit],
    );
    const count = deleted.rows.length;
    if (count === 0) return { deleted: 0, batchId: null };
    const batchId = randomUUID();
    const hash = createHash('sha256')
      .update(JSON.stringify(deleted.rows.map((row) => row.id).sort()))
      .digest('hex');
    await tx.query(
      `INSERT INTO audit_log(actor_kind,action,target_type,target_id,before_hash)
       VALUES('system',$1,'model_request_content',$2,$3)`,
      [`model_request.purged_${count}`, batchId, hash],
    );
    return { deleted: count, batchId };
  });
}
