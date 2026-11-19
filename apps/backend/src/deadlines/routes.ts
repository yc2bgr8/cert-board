import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { Pool } from 'pg';
import { deadlineNoticeAckSchema, type BackendConfig } from '@cert-board/shared';
import { z } from 'zod';
import { AppError } from '../api/errors.js';
import { authorize } from '../auth/authorization.js';
import { requireBrowserIdentity } from '../auth/session.js';
import { readDeadlineScanHeartbeat } from './scan.js';

export function registerDeadlineRoutes<Logger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    Logger
  >,
  pool: Pool,
  config: BackendConfig,
) {
  app.get('/api/deadline-notifications/health', async (request, reply) => {
    const actor = await requireBrowserIdentity(request, pool, config);
    if (!authorize(actor, 'ops.read'))
      throw new AppError(403, 'DEADLINE_HEALTH_FORBIDDEN', '仅管理人员可以查看扫描状态。');
    reply.header('cache-control', 'no-store');
    return readDeadlineScanHeartbeat(pool);
  });
  app.post('/api/deadline-notifications/:id/acknowledge', async (request, reply) => {
    const actor = await requireBrowserIdentity(request, pool, config, { write: true });
    const location = z.object({ id: z.uuid() }).strict().safeParse(request.params);
    const body = deadlineNoticeAckSchema.safeParse(request.body);
    if (!location.success || !body.success)
      throw new AppError(
        400,
        'DEADLINE_NOTICE_INVALID',
        '提醒编号或已读版本无效，请刷新待我处理。',
      );
    const result = await pool.query(
      `UPDATE notification n SET status='acknowledged'
       FROM timer t JOIN goal g ON g.id=t.goal_id AND g.status='active'
       WHERE n.id=$1 AND n.timer_id=t.id AND t.state='active'
         AND n.recipient_id=$2 AND g.owner_user_id=$2
         AND (n.notice->>'dueAt')::timestamptz=t.due_at
         AND COALESCE(n.notice->>'profile',t.profile)=t.profile
         AND COALESCE(n.notice->>'jurisdictionTz',t.jurisdiction_tz)=t.jurisdiction_tz
         AND n.status IN ('pending','acknowledged') AND date_trunc('milliseconds',n.updated_at)=$3::timestamptz`,
      [location.data.id, actor.userId, body.data.seenAt],
    );
    if (!result.rowCount)
      throw new AppError(
        409,
        'DEADLINE_NOTICE_CHANGED',
        '提醒已变化或当前不可处理，请刷新后查看。',
      );
    return reply.code(204).send();
  });
}
