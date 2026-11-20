import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { skillParamsSchema, type BackendConfig } from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { requireBrowserIdentity } from '../auth/session.js';
import { decideSkillVersion, listSkillVersions, readSkillVersion } from './service.js';

const versionParams = skillParamsSchema.extend({ versionId: z.string().uuid() }).strict();
const invalid = () =>
  new AppError(400, 'SKILL_PARAMS_INVALID', '技能编号或版本无效，请刷新技能审核页。');

export function registerSkillRoutes<Logger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    Logger
  >,
  pool: Pool,
  config: BackendConfig,
) {
  app.get('/api/skills', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    await requireBrowserIdentity(request, pool, config);
    return listSkillVersions(pool);
  });
  app.get('/api/skills/:id/versions/:versionId', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    await requireBrowserIdentity(request, pool, config);
    const params = versionParams.safeParse(request.params);
    if (!params.success) throw invalid();
    return readSkillVersion(pool, params.data.id, params.data.versionId);
  });
  app.post('/api/skills/:id/actions', { bodyLimit: 4096 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const actor = await requireBrowserIdentity(request, pool, config, { write: true });
    const params = skillParamsSchema.safeParse(request.params);
    if (!params.success) throw invalid();
    return decideSkillVersion(pool, actor, params.data.id, request.body);
  });
}
