import type {
  FastifyInstance,
  FastifyBaseLogger,
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
} from 'fastify';
import type { Pool } from 'pg';
import {
  documentParamsSchema,
  documentPageParamsSchema,
  projectParamsSchema,
  type BackendConfig,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { requireBrowserIdentity } from '../auth/session.js';
import {
  getDocument,
  listDocuments,
  listDocumentVersions,
  readDocumentPage,
  searchDocuments,
} from './service.js';

function idFrom(params: unknown, project = false) {
  const result = (project ? projectParamsSchema : documentParamsSchema).safeParse(params);
  if (!result.success)
    throw new AppError(400, 'DOCUMENT_ID_INVALID', '资料或项目编号无效，请从资料列表重新选择。');
  return result.data.id;
}

export function registerDocumentRoutes<Logger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    Logger
  >,
  pool: Pool,
  config: BackendConfig,
) {
  app.get('/api/projects/:id/documents', async (request, reply) => {
    const actor = await requireBrowserIdentity(request, pool, config);
    reply.header('cache-control', 'no-store');
    return listDocuments(pool, actor, idFrom(request.params, true), request.query);
  });
  app.get('/api/projects/:id/documents/search', async (request, reply) => {
    const actor = await requireBrowserIdentity(request, pool, config);
    reply.header('cache-control', 'no-store');
    return searchDocuments(pool, actor, idFrom(request.params, true), request.query);
  });
  app.get('/api/documents/:id', async (request, reply) => {
    const actor = await requireBrowserIdentity(request, pool, config);
    reply.header('cache-control', 'no-store');
    return getDocument(pool, actor, idFrom(request.params));
  });
  app.get('/api/documents/:id/versions', async (request, reply) => {
    const actor = await requireBrowserIdentity(request, pool, config);
    reply.header('cache-control', 'no-store');
    return listDocumentVersions(pool, actor, idFrom(request.params), request.query);
  });
  app.get('/api/documents/:id/versions/:version/pages/:page', async (request, reply) => {
    const actor = await requireBrowserIdentity(request, pool, config);
    reply.header('cache-control', 'no-store');
    const location = documentPageParamsSchema.safeParse(request.params);
    if (!location.success)
      throw new AppError(400, 'DOCUMENT_LOCATION_INVALID', '资料版本或页码无效，请重新选择。');
    return readDocumentPage(
      pool,
      actor,
      location.data.id,
      location.data.version,
      location.data.page,
      request.query,
    );
  });
}
