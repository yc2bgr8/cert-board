import type { Pool } from 'pg';
import { claimRunLease, releaseRunLease } from '../runs/lease.js';
import { AppError } from '../api/errors.js';
import { ToolRegistry, type ToolDefinition, type ToolExecutionContext } from '../tools/registry.js';

export type ToolRuntimeOptions = {
  pool: Pool;
  definitions: readonly ToolDefinition[];
  runId: string;
  userId: string;
  ownerId: string;
  signal: AbortSignal;
  environment?: 'development' | 'test' | 'production';
  ttlSeconds?: number;
};

export async function createToolRuntime(options: ToolRuntimeOptions) {
  const { pool, runId, userId, ownerId, signal, ttlSeconds } = options;
  const definitions = [...options.definitions];
  const environment = options.environment ?? process.env.NODE_ENV ?? 'production';
  if (
    !['development', 'test', 'production'].includes(environment) ||
    (process.env.NODE_ENV === 'production' && environment !== 'production') ||
    !(signal instanceof AbortSignal) ||
    signal.aborted
  )
    throw new AppError(409, 'AGENT_RUNTIME_UNAVAILABLE', '运行环境无效或已取消，不能开始执行。');
  const lease = Object.freeze(
    await claimRunLease(pool, {
      runId,
      userId,
      ownerId,
      ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
    }),
  );
  const identity = Object.freeze({
    runId: lease.runId,
    userId,
    ownerId: lease.ownerId,
    generation: lease.generation,
  });
  const guard = async (ctx: ToolExecutionContext) => {
    if (
      signal.aborted ||
      ctx.runId !== identity.runId ||
      ctx.actor.userId !== identity.userId ||
      ctx.actor.runId !== identity.runId
    )
      throw new Error('runtime_stopped');
    // Registry已经按标准顺序锁定本run；必须复用该事务，不能另开连接等待自己的锁。
    const checked = await ctx.tx.query(
      `SELECT id FROM run WHERE id=$1 AND user_id=$2 AND status='running'
       AND lease_owner=$3 AND lease_generation=$4 AND lease_expires_at>clock_timestamp()`,
      [identity.runId, identity.userId, identity.ownerId, identity.generation],
    );
    if (checked.rowCount !== 1 || signal.aborted) throw new Error('runtime_lease_lost');
  };
  try {
    if (signal.aborted)
      throw new AppError(409, 'AGENT_RUNTIME_UNAVAILABLE', '运行已取消，不能继续开始执行。');
    const registry = new ToolRegistry(pool, definitions, {
      environment: environment as 'development' | 'test' | 'production',
      runtimeGuard: guard,
      signal,
    });
    return Object.freeze({ registry, lease });
  } catch (error) {
    await releaseRunLease(pool, identity).catch(() => undefined);
    throw error;
  }
}
