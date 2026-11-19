import type {
  FastifyInstance,
  FastifyBaseLogger,
  FastifyRequest,
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
} from 'fastify';
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import {
  documentParamsSchema,
  documentPageParamsSchema,
  documentOriginalInputSchema,
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
import { maximumDocumentBytes } from './docsvc-client.js';
import { queueOriginalDocument } from './parse-tasks.js';

const archiveParams = documentPageParamsSchema.pick({ id: true, version: true });
const uploadQuery = documentOriginalInputSchema
  .pick({ name: true, format: true, dataLevel: true, sourceKey: true })
  .extend({
    sourceKey: documentOriginalInputSchema.shape.sourceKey.optional(),
    dataLevel: documentOriginalInputSchema.shape.dataLevel.default('internal'),
  });

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
  originals?: DocumentBlobStore,
) {
  if (originals)
    app.register(async (upload) => {
      const receiving = new Map<FastifyRequest, ReturnType<typeof setTimeout>>();
      const release = async (request: FastifyRequest) => {
        clearTimeout(receiving.get(request));
        receiving.delete(request);
      };
      upload.addContentTypeParser(
        'application/octet-stream',
        { parseAs: 'buffer', bodyLimit: maximumDocumentBytes },
        (_request, body, done) => done(null, body),
      );
      upload.post(
        '/api/projects/:id/documents/original',
        {
          bodyLimit: maximumDocumentBytes,
          onRequest: async (request) => {
            await requireBrowserIdentity(request, pool, config, { write: true });
            if (!config.CERT_DOCSVC_URL)
              throw new AppError(
                503,
                'DOCUMENT_PARSER_DISABLED',
                '资料解析未启用。请启动解析服务，并为 API 和后台进程配置 CERT_DOCSVC_URL。',
              );
            if (request.raw.aborted)
              throw new AppError(400, 'DOCUMENT_UPLOAD_INCOMPLETE', '原件传输中断，请重新提交。');
            if (receiving.size >= 2)
              throw new AppError(429, 'DOCUMENT_UPLOAD_BUSY', '当前有原件正在上传，请稍后重试。');
            const timeout = setTimeout(() => request.raw.destroy(), 45_000);
            timeout.unref();
            receiving.set(request, timeout);
          },
          preHandler: async (request) => {
            clearTimeout(receiving.get(request));
          },
          onResponse: release,
          onRequestAbort: release,
        },
        async (request, reply) => {
          const actor = await requireBrowserIdentity(request, pool, config, { write: true });
          const projectId = idFrom(request.params, true);
          const input = uploadQuery.safeParse(request.query);
          if (!input.success || !Buffer.isBuffer(request.body) || !request.body.length)
            throw new AppError(
              400,
              'DOCUMENT_UPLOAD_INVALID',
              '请选择支持的原件，并填写有效资料名。',
            );
          const { name, format, dataLevel } = input.data;
          const nameHash = createHash('sha256').update(name).digest('hex');
          const fields = {
            name,
            format,
            dataLevel,
            sourceKey: input.data.sourceKey ?? `file-${nameHash}`,
          };
          const sourceSnapshot = createHash('sha256')
            .update('cert-board-original-v1\0')
            .update(JSON.stringify(fields))
            .update('\0')
            .update(request.body)
            .digest('hex');
          const saved = await queueOriginalDocument(
            pool,
            originals,
            actor,
            {
              ...fields,
              projectId,
              sourceSnapshot,
              sourcePath: fields.name,
              authorType: 'human',
            },
            request.body,
          );
          return reply
            .code(saved.created ? 202 : 200)
            .header('cache-control', 'no-store')
            .send(saved);
        },
      );
    });
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
