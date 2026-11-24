import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { factDecisionInputSchema, type BackendConfig } from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { requireBrowserIdentity } from '../auth/session.js';
import { decideFactCandidate, listFactCandidates } from './facts.js';

const projectParams = z.strictObject({ projectId: z.uuid() });
const candidateParams = projectParams.extend({ candidateId: z.uuid() });
const invalid = () =>
  new AppError(400, 'FACT_REQUEST_INVALID', '项目、候选、版本或处理内容无效，请刷新后核对。');

export function registerKnowledgeRoutes<Logger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    Logger
  >,
  pool: Pool,
  config: BackendConfig,
) {
  app.get('/api/projects/:projectId/fact-candidates', async (request, reply) => {
    const actor = await requireBrowserIdentity(request, pool, config);
    const loc = projectParams.safeParse(request.params);
    const filter = z.strictObject({ afterId: z.uuid().optional() }).safeParse(request.query);
    if (!loc.success || !filter.success) throw invalid();
    reply.header('cache-control', 'no-store');
    return listFactCandidates(pool, actor, loc.data.projectId, filter.data.afterId);
  });

  app.post(
    '/api/projects/:projectId/fact-candidates/:candidateId/decision',
    async (request, reply) => {
      const loc = candidateParams.safeParse(request.params);
      const body = factDecisionInputSchema.safeParse(request.body);
      if (!loc.success || !body.success) throw invalid();
      const tx = await pool.connect();
      try {
        await tx.query('BEGIN');
        const actor = await requireBrowserIdentity(request, tx, config, { write: true });
        const current = await tx.query(
          `SELECT s.id FROM web_session s JOIN app_user u ON u.id=s.user_id
          WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='active' FOR SHARE OF s,u`,
          [actor.sessionId, actor.userId],
        );
        if (!current.rowCount)
          throw new AppError(401, 'LOGIN_REQUIRED', '登录已失效，请重新登录。');
        const verified = await requireBrowserIdentity(request, tx, config, { write: true });
        const result = await decideFactCandidate(
          tx,
          verified,
          loc.data.projectId,
          loc.data.candidateId,
          body.data,
        );
        await tx.query('COMMIT');
        return reply.header('cache-control', 'no-store').send(result);
      } catch (err) {
        await tx.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        tx.release();
      }
    },
  );
}
