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
import type { DocumentBlobStore } from '../documents/blob-store.js';
import {
  listProjects,
  getProject,
  getProjectGoals,
  createRegistrationProjectTx,
} from './service.js';

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
  store?: DocumentBlobStore,
) {
  app.post('/api/projects', { bodyLimit: 4096 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      const session = await requireBrowserIdentity(request, tx, config, { write: true });
      const locked = await tx.query(
        `SELECT s.id FROM web_session s JOIN app_user u ON u.id=s.user_id
         WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
           AND u.status='active' FOR SHARE OF s,u`,
        [session.sessionId, session.userId],
      );
      if (!locked.rowCount) throw new AppError(401, 'LOGIN_REQUIRED', '登录已失效，请重新登录。');
      if (!store)
        throw new AppError(
          503,
          'PROJECT_STORAGE_UNAVAILABLE',
          '工作区文件存储暂不可用，请稍后重试。',
        );
      const actor = await requireBrowserIdentity(request, tx, config, { write: true });
      const result = await createRegistrationProjectTx(tx, actor, request.body, store);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError(
        500,
        'PROJECT_CREATE_FAILED',
        '项目及工作区创建未完成，请保留表单后重试。',
      );
    } finally {
      tx.release();
    }
  });
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
