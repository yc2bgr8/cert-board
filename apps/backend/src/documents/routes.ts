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
  readWebArchiveInfo,
  searchDocuments,
} from './service.js';
import type { DocumentBlobStore } from './blob-store.js';

const archiveParams = documentPageParamsSchema.pick({ id: true, version: true });

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
  store?: DocumentBlobStore,
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
  app.get('/api/documents/:id/versions/:version/web-archive-info', async (request, reply) => {
    const actor = await requireBrowserIdentity(request, pool, config);
    const location = archiveParams.safeParse(request.params);
    if (!location.success)
      throw new AppError(400, 'DOCUMENT_LOCATION_INVALID', '网页存档版本无效。');
    reply.header('cache-control', 'no-store');
    return readWebArchiveInfo(pool, actor, location.data.id, location.data.version);
  });
  app.get('/api/documents/:id/versions/:version/web-archive', async (request, reply) => {
    const actor = await requireBrowserIdentity(request, pool, config);
    const location = archiveParams.safeParse(request.params);
    if (!location.success)
      throw new AppError(400, 'DOCUMENT_LOCATION_INVALID', '网页存档版本无效。');
    const archive = await readWebArchiveInfo(pool, actor, location.data.id, location.data.version);
    if (!store) throw new AppError(503, 'WEB_ARCHIVE_UNAVAILABLE', '网页存档文件存储不可用。');
    reply.header('cache-control', 'no-store');
    reply.header('content-security-policy', "default-src 'none'; sandbox");
    reply.header(
      'content-disposition',
      `attachment; filename="web-${archive.sha256.slice(0, 16)}.snapshot"`,
    );
    return reply.type('application/octet-stream').send(await store.get(archive.sha256));
  });
}
