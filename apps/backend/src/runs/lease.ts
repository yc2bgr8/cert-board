import type { Pool, PoolClient } from 'pg';
import {
  claimRunLeaseSchema,
  renewRunLeaseSchema,
  runLeaseIdentitySchema,
  runLeaseRecordSchema,
  type RunLeaseRecord,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { lockOwnedRun } from './lock.js';

type LeaseRow = {
  id: string;
  user_id: string;
  status: string;
  lease_owner: string | null;
  lease_generation: string;
  lease_expires_at: Date | null;
};
const invalid = () =>
  new AppError(
    400,
    'RUN_LEASE_INPUT_INVALID',
    '运行执行权参数无效，请使用后台分配的运行、持有者和代次。',
  );
const lost = () =>
  new AppError(409, 'RUN_LEASE_LOST', '执行权已失效或由其他进程接管，旧进程必须停止。');
async function transaction<T>(pool: Pool, operation: (tx: PoolClient) => Promise<T>) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const value = await operation(tx);
    await tx.query('COMMIT');
    return value;
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'RUN_LEASE_FAILED', '执行权登记失败，请先停止执行并核对运行状态。');
  } finally {
    tx.release();
  }
}
async function locked(tx: PoolClient, runId: string, userId: string) {
  return lockOwnedRun(tx, runId, userId);
}
async function now(tx: PoolClient) {
  return (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
}
function record(row: LeaseRow): RunLeaseRecord {
  return runLeaseRecordSchema.parse({
    runId: row.id,
    ownerId: row.lease_owner,
    generation: Number(row.lease_generation),
    expiresAt: row.lease_expires_at?.toISOString(),
  });
}
function checkActive(row: LeaseRow) {
  if (!['queued', 'running'].includes(row.status))
    throw new AppError(
      409,
      'RUN_LEASE_INACTIVE',
      '运行已停止、完成或正在等待，不能继续领取执行权。',
    );
}
function matches(row: LeaseRow, ownerId: string, generation: number) {
  return row.lease_owner === ownerId && Number(row.lease_generation) === generation;
}

export async function claimRunLease(pool: Pool, input: unknown) {
  const parsed = claimRunLeaseSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  const data = parsed.data;
  return transaction(pool, async (tx) => {
    const row = await locked(tx, data.runId, data.userId);
    checkActive(row);
    const clock = await now(tx);
    if (
      row.lease_owner &&
      row.lease_expires_at &&
      row.lease_expires_at.getTime() > clock.getTime()
    ) {
      if (row.lease_owner !== data.ownerId)
        throw new AppError(409, 'RUN_LEASE_BUSY', '运行已由其他进程持有，请等待执行权释放或到期。');
      return record(row);
    }
    const changed = await tx.query<LeaseRow>(
      `UPDATE run SET lease_owner=$1,lease_generation=lease_generation+1,lease_expires_at=clock_timestamp()+$2*INTERVAL '1 second',status='running',version=version+1,updated_at=CURRENT_TIMESTAMP
      WHERE id=$3 RETURNING id,user_id,status,lease_owner,lease_generation,lease_expires_at`,
      [data.ownerId, data.ttlSeconds, data.runId],
    );
    await tx.query(
      "INSERT INTO audit_log(actor_kind,action,target_type,target_id) VALUES('system','run.lease_claimed','run',$1)",
      [data.runId],
    );
    return record(changed.rows[0]!);
  });
}
export async function renewRunLease(pool: Pool, input: unknown) {
  const parsed = renewRunLeaseSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  const data = parsed.data;
  return transaction(pool, async (tx) => {
    const row = await locked(tx, data.runId, data.userId);
    checkActive(row);
    const clock = await now(tx);
    if (
      !matches(row, data.ownerId, data.generation) ||
      !row.lease_expires_at ||
      row.lease_expires_at.getTime() <= clock.getTime()
    )
      throw lost();
    const result = await tx.query<LeaseRow>(
      `UPDATE run SET lease_expires_at=clock_timestamp()+$1*INTERVAL '1 second',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$2
      RETURNING id,user_id,status,lease_owner,lease_generation,lease_expires_at`,
      [data.ttlSeconds, data.runId],
    );
    return record(result.rows[0]!);
  });
}
export async function assertRunLease(pool: Pool, input: unknown) {
  const parsed = runLeaseIdentitySchema.safeParse(input);
  if (!parsed.success) throw invalid();
  const data = parsed.data;
  return transaction(pool, async (tx) => {
    const row = await locked(tx, data.runId, data.userId);
    checkActive(row);
    const clock = await now(tx);
    if (
      !matches(row, data.ownerId, data.generation) ||
      !row.lease_expires_at ||
      row.lease_expires_at.getTime() <= clock.getTime()
    )
      throw lost();
    return record(row);
  });
}
export async function releaseRunLease(pool: Pool, input: unknown) {
  const parsed = runLeaseIdentitySchema.safeParse(input);
  if (!parsed.success) throw invalid();
  const data = parsed.data;
  return transaction(pool, async (tx) => {
    const row = await locked(tx, data.runId, data.userId);
    if (!matches(row, data.ownerId, data.generation)) throw lost();
    await tx.query(
      'UPDATE run SET lease_owner=NULL,lease_expires_at=NULL,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1',
      [data.runId],
    );
    await tx.query(
      "INSERT INTO audit_log(actor_kind,action,target_type,target_id) VALUES('system','run.lease_released','run',$1)",
      [data.runId],
    );
    return { runId: data.runId, generation: data.generation, released: true };
  });
}
