import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { goalArrivalInputSchema, type BackendConfig } from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { authorize } from '../auth/authorization.js';
import { requireBrowserIdentity } from '../auth/session.js';
import { controlGoal, recordGoalEvent } from './goal-events.js';

const parameters = z.object({ id: z.string().uuid() }).strict();
const invalid = () =>
  new AppError(400, 'GOAL_ACTION_INVALID', '目标操作参数无效，请从当前项目重新打开。');

export function registerGoalWakeupRoutes<Logger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    Logger
  >,
  pool: Pool,
  config: BackendConfig,
) {
  app.post(
    '/api/me/verification-notices/:id/acknowledge',
    { bodyLimit: 1024 },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const actor = await requireBrowserIdentity(request, pool, config, { write: true });
      const params = parameters.safeParse(request.params);
      if (!params.success) throw invalid();
      await pool.query(
        `UPDATE verification_notice SET acknowledged_at=clock_timestamp()
       WHERE id=$1 AND recipient_user_id=$2 AND acknowledged_at IS NULL`,
        [params.data.id, actor.userId],
      );
      return reply.code(204).send();
    },
  );
  app.post('/api/goals/:id/control', { bodyLimit: 20_000 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const actor = await requireBrowserIdentity(request, pool, config, { write: true });
    const params = parameters.safeParse(request.params);
    if (!params.success) throw invalid();
    return controlGoal(pool, actor, params.data.id, request.body);
  });
  app.post('/api/goals/:id/arrival', { bodyLimit: 4096 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const actor = await requireBrowserIdentity(request, pool, config, { write: true });
    const params = parameters.safeParse(request.params);
    const arrival = goalArrivalInputSchema.safeParse(request.body);
    if (!params.success || !arrival.success) throw invalid();
    const goal = (
      await pool.query<{ project_id: string; owner_user_id: string; source_key: string }>(
        `SELECT p.id AS project_id,p.owner_user_id,w.source_key FROM goal_wait w JOIN goal g ON g.id=w.goal_id
       JOIN cert_project p ON p.id=g.project_id WHERE g.id=$1 AND w.source='manual' AND w.source_key=$2
       AND w.cancelled_at IS NULL AND w.responded_at IS NULL`,
        [params.data.id, arrival.data.sourceKey],
      )
    ).rows[0];
    if (
      !goal ||
      !authorize(actor, 'project.write', {
        projectId: goal.project_id,
        ownerUserId: goal.owner_user_id,
      })
    )
      throw new AppError(404, 'GOAL_WAIT_UNAVAILABLE', '没有找到可确认到达的目标等待。');
    return { eventId: await recordGoalEvent(pool, params.data.id, 'manual', goal.source_key) };
  });
}
