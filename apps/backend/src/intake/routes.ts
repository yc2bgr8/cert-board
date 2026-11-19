import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { BackendConfig } from '@cert-board/shared';
import { requireBrowserIdentity } from '../auth/session.js';
import { AppError } from '../api/errors.js';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import { createDocumentUploadGate, monitorDocumentUpload } from '../documents/upload-gate.js';
import { maximumIntakeBytes } from './archive.js';
import { editIntakeCategory, readIntakeReport, requestIntake } from './service.js';

export function registerIntakeRoutes<Logger extends FastifyBaseLogger>(
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
  app.get('/api/intake/:id', async (request, reply) => {
    const actor = await requireBrowserIdentity(request, pool, config);
    const id = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!id.success) throw new AppError(400, 'INTAKE_ID_INVALID', '导入任务编号无效。');
    reply.header('cache-control', 'no-store');
    return readIntakeReport(pool, actor, id.data.id);
  });
  app.patch('/api/intake/:id/category', { bodyLimit: 8_192 }, async (request, reply) => {
    const actor = await requireBrowserIdentity(request, pool, config, { write: true });
    const id = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!id.success) throw new AppError(400, 'INTAKE_ID_INVALID', '导入任务编号无效。');
    reply.header('cache-control', 'no-store');
    return editIntakeCategory(pool, actor, id.data.id, request.body);
  });
  if (!store) return;
  app.register(async (upload) => {
    const gate = createDocumentUploadGate<FastifyRequest>(1);
    const streams = new WeakMap<FastifyRequest, ReturnType<typeof monitorDocumentUpload>>();
    const release = async (request: FastifyRequest) => {
      gate.release(request);
      streams.get(request)?.destroy();
      streams.delete(request);
    };
    upload.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: maximumIntakeBytes },
      (_request, data, done) => done(null, data),
    );
    upload.post(
      '/api/intake',
      {
        bodyLimit: maximumIntakeBytes,
        onRequest: async (request) => {
          await requireBrowserIdentity(request, pool, config, { write: true });
          if (!config.CERT_DOCSVC_URL)
            throw new AppError(
              503,
              'INTAKE_PARSER_DISABLED',
              '请启动文档解析并为 API 和后台进程配置 CERT_DOCSVC_URL。',
            );
          if (request.raw.aborted)
            throw new AppError(400, 'INTAKE_UPLOAD_INCOMPLETE', '文件传输中断，请重新提交。');
          if (!gate.acquire(request, () => request.raw.destroy()))
            throw new AppError(429, 'INTAKE_UPLOAD_BUSY', '已有资料包正在上传，请稍后重试。');
        },
        preParsing: (request, _reply, payload, done) => {
          const body = monitorDocumentUpload(payload, () => gate.receive(request));
          streams.set(request, body);
          done(null, body);
        },
        preHandler: async (request) => {
          gate.finishBody(request);
        },
        onResponse: release,
        onRequestAbort: release,
      },
      async (request, reply) => {
        const actor = await requireBrowserIdentity(request, pool, config, { write: true });
        if (!Buffer.isBuffer(request.body))
          throw new AppError(400, 'INTAKE_INPUT_INVALID', '请选择 ZIP 压缩包。');
        const saved = await requestIntake(pool, store, actor, request.query, request.body);
        return reply
          .code(saved.created ? 202 : 200)
          .header('cache-control', 'no-store')
          .send(saved);
      },
    );
  });
}
