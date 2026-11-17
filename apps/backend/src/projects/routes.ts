import type {
  FastifyInstance,
  FastifyBaseLogger,
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
} from 'fastify';
import type { Pool } from 'pg';
import {
  projectListSchema,
  goalListSchema,
  projectRecordSchema,
  projectListOptionsSchema,
  projectParamsSchema,
  type BackendConfig,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { requireBrowserIdentity } from '../auth/session.js';
import { listProjects, getProject, getProjectGoals } from './service.js';

function listOptions(query: unknown) {
  const result = projectListOptionsSchema.safeParse(query);
  if (!result.success)
    throw new AppError(
      400,
      'PAGINATION_INVALID',
      '分页参数无效，请每次读取1至50条并使用返回的续读位置。',
    );
  return {
    limit: result.data.limit,
    ...(result.data.cursor === undefined ? {} : { cursor: result.data.cursor }),
  };
}
function projectId(params: unknown) {
  const result = projectParamsSchema.safeParse(params);
  if (!result.success)
    throw new AppError(400, 'PROJECT_ID_INVALID', '项目编号无效，请从列表重新选择。');
  return result.data.id;
}

export function registerProjectRoutes<Logger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    Logger
  >,
  pool: Pool,
  config: BackendConfig,
) {
  app.get('/api/projects', async (request, reply) => {
    const identity = await requireBrowserIdentity(request, pool, config);
    reply.header('cache-control', 'no-store');
    return projectListSchema.parse(await listProjects(pool, identity, listOptions(request.query)));
  });
  app.get('/api/projects/:id', async (request, reply) => {
    const identity = await requireBrowserIdentity(request, pool, config);
    reply.header('cache-control', 'no-store');
    return projectRecordSchema.parse(await getProject(pool, identity, projectId(request.params)));
  });
  app.get('/api/projects/:id/goals', async (request, reply) => {
    const identity = await requireBrowserIdentity(request, pool, config);
    reply.header('cache-control', 'no-store');
    return goalListSchema.parse(
      await getProjectGoals(pool, identity, projectId(request.params), listOptions(request.query)),
    );
  });
}
