import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import { apiErrorSchema, healthResponseSchema, type BackendConfig } from '@cert-board/shared';
import { createDependencies, type HealthDependencies } from './dependencies.js';
import { createLogger } from './logger.js';

async function dependencyStatus(check: () => Promise<void>): Promise<'up' | 'down'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      check(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('依赖检查超时')), 5_000);
        timer.unref();
      }),
    ]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createApp(
  config: BackendConfig,
  dependencies: HealthDependencies = createDependencies(config),
) {
  const app = Fastify({
    loggerInstance: createLogger(config),
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    bodyLimit: 1024 * 1024,
  });

  app.setErrorHandler((error, request, reply) => {
    const invalidRequest =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500;
    const statusCode = invalidRequest ? 400 : 500;
    const code = invalidRequest ? 'INVALID_REQUEST' : 'INTERNAL_ERROR';
    app.log.warn({ event: 'request_failed', requestId: request.id, code }, '请求未完成');
    reply.status(statusCode).send(
      apiErrorSchema.parse({
        error: {
          code,
          message: invalidRequest
            ? '请求格式不正确，请检查输入后重试。'
            : '服务暂时不可用，请稍后重试。',
          requestId: request.id,
        },
      }),
    );
  });
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send(
      apiErrorSchema.parse({
        error: {
          code: 'NOT_FOUND',
          message: '没有找到该接口，请检查地址。',
          requestId: request.id,
        },
      }),
    );
  });
  app.get('/health', async (_request, reply) => {
    const [database, storage] = await Promise.all([
      dependencyStatus(() => dependencies.checkDatabase()),
      dependencyStatus(() => dependencies.checkStorage()),
    ]);
    const status = database === 'up' && storage === 'up' ? 'ok' : 'degraded';
    return reply.status(status === 'ok' ? 200 : 503).send(
      healthResponseSchema.parse({
        status,
        dependencies: { database, storage },
      }),
    );
  });
  app.addHook('onClose', async () => dependencies.close());
  return app;
}
