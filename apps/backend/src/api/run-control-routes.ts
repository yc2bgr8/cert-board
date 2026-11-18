import type {
  FastifyInstance,
  FastifyBaseLogger,
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
} from 'fastify';
import type { Pool } from 'pg';
import {
  browserIdentitySchema,
  runStopParamsSchema,
  runStopInputSchema,
  type BackendConfig,
} from '@cert-board/shared';
import { requireBrowserIdentity } from '../auth/session.js';
import { authorizeRunStop, notifyRunStop, stopOwnedRun } from '../runs/control.js';
import { AppError } from './errors.js';

export function registerRunControlRoutes<Logger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    Logger
  >,
  pool: Pool,
  config: BackendConfig,
) {
  app.post('/api/runs/:id/stop', { bodyLimit: 4096 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const params = runStopParamsSchema.safeParse(request.params);
    if (!params.success || !runStopInputSchema.safeParse(request.body ?? {}).success)
      throw new AppError(
        400,
        'RUN_STOP_INPUT_INVALID',
        '运行编号或停止请求无效，请从当前对话重试。',
      );
    const runId = params.data.id;
    const first = await requireBrowserIdentity(request, pool, config, { write: true });
    await authorizeRunStop(pool, first, runId);
    // 首次通知先提交，让持有工具事务锁的worker及时收到取消；数据库状态仍须在下方事务重验并落库。
    await notifyRunStop(pool, runId, first.userId).catch(() => undefined);
    const tx = await pool.connect();
    let result;
    try {
      await tx.query('BEGIN');
      const session = await tx.query(
        `SELECT s.id FROM web_session s JOIN app_user u ON u.id=s.user_id
         WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
         AND u.status='active' FOR SHARE OF s,u`,
        [first.sessionId, first.userId],
      );
      if (session.rowCount !== 1)
        throw new AppError(401, 'LOGIN_REQUIRED', '登录已失效，请重新登录。');
      const checked = await requireBrowserIdentity(request, tx, config, { write: true });
      const actor = browserIdentitySchema.parse(checked);
      result = await stopOwnedRun(tx, actor, runId);
      await tx.query('COMMIT');
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError(500, 'RUN_STOP_FAILED', '停止状态未能完成登记，请刷新核对后重试。');
    } finally {
      tx.release();
    }
    await notifyRunStop(pool, runId, first.userId).catch(() => {
      try {
        console.warn('RUN_STOP_NOTIFY_DEFERRED');
      } catch {
        /* 已提交的停止结果不能因日志失败变成失败。 */
      }
    });
    return result;
  });
}
