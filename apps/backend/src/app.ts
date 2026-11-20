import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import type pg from 'pg';
import type { Client as MinioClient } from 'minio';
import { apiErrorSchema, healthResponseSchema, type BackendConfig } from '@cert-board/shared';
import { createDependencies, type HealthDependencies } from './dependencies.js';
import { createLogger } from './logger.js';
import { AppError } from './api/errors.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerProjectRoutes } from './projects/routes.js';
import { registerDocumentRoutes } from './documents/routes.js';
import { BlobStore, type DocumentBlobStore } from './documents/blob-store.js';
import { maximumDocumentBytes } from './documents/docsvc-client.js';
import { maximumIntakeBytes } from './intake/archive.js';
import { registerIntakeRoutes } from './intake/routes.js';
import { registerWorkspaceRoutes } from './workspace/routes.js';
import { registerProposalRoutes } from './api/proposal-routes.js';
import { registerReviewRoutes } from './api/review-routes.js';
import { registerRunControlRoutes } from './api/run-control-routes.js';
import { registerApprovalRoutes } from './api/approval-routes.js';
import { registerConversationReadRoutes } from './api/conversation-read-routes.js';
import { registerConversationWriteRoutes } from './api/conversation-write-routes.js';
import { registerExternalModelRoutes } from './external-model/routes.js';
import { registerDeadlineRoutes } from './deadlines/routes.js';
import { registerSkillRoutes } from './skills/routes.js';
import { registerGoalWakeupRoutes } from './goals/routes.js';
import type { ExternalModelRuntime } from './modelgw/external.js';
import type { VerificationRuntime } from './external-model/verification-runtime.js';

export interface AppDependencies extends HealthDependencies {
  database?: pg.Pool;
  storage?: MinioClient;
  blobStore?: DocumentBlobStore;
  externalModelRuntime?: ExternalModelRuntime;
  verificationRuntime?: VerificationRuntime;
  verificationPolling?: boolean;
}

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
  dependencies: AppDependencies = createDependencies(config),
) {
  const app = Fastify({
    loggerInstance: createLogger(config),
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    bodyLimit: 1024 * 1024,
  });
  app.register(cookie);
  if (dependencies.database) {
    const blobStore =
      dependencies.blobStore ??
      (dependencies.storage ? new BlobStore(dependencies.storage, config.MINIO_BUCKET) : undefined);
    registerAuthRoutes(app, dependencies.database, config);
    registerProjectRoutes(app, dependencies.database, config);
    const originals =
      dependencies.blobStore ??
      (dependencies.storage
        ? new BlobStore(dependencies.storage, config.MINIO_BUCKET, maximumDocumentBytes)
        : undefined);
    registerDocumentRoutes(app, dependencies.database, config, blobStore, originals);
    const intakeStore =
      dependencies.blobStore ??
      (dependencies.storage
        ? new BlobStore(dependencies.storage, config.MINIO_BUCKET, maximumIntakeBytes)
        : undefined);
    registerIntakeRoutes(app, dependencies.database, config, intakeStore);
    registerProposalRoutes(app, dependencies.database, config);
    registerReviewRoutes(app, dependencies.database, config);
    registerRunControlRoutes(app, dependencies.database, config);
    registerApprovalRoutes(app, dependencies.database, config);
    registerConversationReadRoutes(app, dependencies.database, config);
    registerConversationWriteRoutes(app, dependencies.database, config);
    registerDeadlineRoutes(app, dependencies.database, config);
    registerSkillRoutes(app, dependencies.database, config);
    registerGoalWakeupRoutes(app, dependencies.database, config);
    registerWorkspaceRoutes(app, dependencies.database, config, blobStore);
    registerExternalModelRoutes(
      app,
      dependencies.database,
      config,
      blobStore,
      dependencies.externalModelRuntime,
      dependencies.verificationRuntime,
      dependencies.verificationPolling,
    );
  }
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    const invalidRequest =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500;
    const publicError = error instanceof AppError ? error : undefined;
    const statusCode = publicError?.statusCode ?? (invalidRequest ? 400 : 500);
    const code = publicError?.code ?? (invalidRequest ? 'INVALID_REQUEST' : 'INTERNAL_ERROR');
    app.log.warn({ event: 'request_failed', requestId: request.id, code }, '请求未完成');
    reply.status(statusCode).send(
      apiErrorSchema.parse({
        error: {
          code,
          message:
            publicError?.message ??
            (invalidRequest
              ? '请求格式不正确，请检查输入后重试。'
              : '服务暂时不可用，请稍后重试。'),
          requestId: request.id,
          ...(publicError?.details ? { details: publicError.details } : {}),
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
