import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  skillParamsSchema,
  skillRollbackDecisionInputSchema,
  skillRollbackPolicyInputSchema,
  type BackendConfig,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { requireBrowserIdentity } from '../auth/session.js';
import { decideSkillVersion, listSkillVersions, readSkillVersion } from './service.js';
import {
  decideSkillRollbackProposal,
  getSkillRollbackPolicy,
  listSkillRollbackProposals,
  saveSkillRollbackPolicy,
} from './rollback.js';

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
  app.get('/api/skill-rollback-policy', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    await requireBrowserIdentity(request, pool, config);
    return getSkillRollbackPolicy(pool);
  });
  app.post('/api/skill-rollback-policy', { bodyLimit: 1024 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const actor = await requireBrowserIdentity(request, pool, config, { write: true });
    const parsed = skillRollbackPolicyInputSchema.safeParse(request.body);
    if (!parsed.success)
      throw new AppError(400, 'SKILL_ROLLBACK_POLICY_INVALID', '请填写有效的样本数和退回率。');
    return saveSkillRollbackPolicy(pool, actor, parsed.data);
  });
  app.get('/api/skill-rollback-proposals', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    await requireBrowserIdentity(request, pool, config);
    return listSkillRollbackProposals(pool);
  });
  app.post(
    '/api/skill-rollback-proposals/:id/decision',
    { bodyLimit: 1024 },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const actor = await requireBrowserIdentity(request, pool, config, { write: true });
      const params = z.object({ id: z.uuid() }).strict().safeParse(request.params);
      const parsed = skillRollbackDecisionInputSchema.safeParse(request.body);
      if (!params.success || !parsed.success) throw invalid();
      return decideSkillRollbackProposal(pool, actor, params.data.id, parsed.data);
    },
  );
}
