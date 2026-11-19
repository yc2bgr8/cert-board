import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  externalModelArchivePageSchema,
  externalModelConversationCursorSchema,
  externalModelConversationInputSchema,
  externalModelConversationListSchema,
  externalModelExchangeListSchema,
  externalModelMessageInputSchema,
  externalModelShareInputSchema,
  externalModelWordInputSchema,
  externalModelWordListSchema,
  type BackendConfig,
  type BrowserIdentity,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { requireBrowserIdentity } from '../auth/session.js';
import { usdToNano } from '../budget/meter.js';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import type { ExternalModelRuntime } from '../modelgw/external.js';
import { ExternalModels } from './service.js';

const identifier = z.object({ id: z.string().uuid() }).strict();
function checked<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
) {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new AppError(400, 'EXTERNAL_INPUT_INVALID', '外部模型参数有误，请核对后重试。');
  return parsed.data;
}
const id = (request: FastifyRequest) => checked(identifier, request.params).id;
const cursor = (request: FastifyRequest) =>
  checked(z.object({ cursor: z.uuid().optional() }).strict(), request.query).cursor;

export function registerExternalModelRoutes<Logger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    Logger
  >,
  pool: Pool,
  config: BackendConfig,
  blobStore?: DocumentBlobStore,
  runtime?: ExternalModelRuntime,
) {
  if (
    runtime &&
    (config.NODE_ENV !== 'test' || process.env.NODE_ENV !== 'test' || runtime.kind !== 'fixture')
  )
    throw new Error('EXTERNAL_MODEL_FIXTURE_TEST_ONLY');
  const service = new ExternalModels(
    pool,
    blobStore,
    runtime,
    usdToNano(config.EXTERNAL_MODEL_MONTHLY_USD),
  );
  const prefix = '/api/external-model';
  const read = (request: FastifyRequest) => requireBrowserIdentity(request, pool, config);
  const write = async <T>(
    request: FastifyRequest,
    operation: (tx: PoolClient, actor: BrowserIdentity) => Promise<T>,
  ) => {
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query("SET LOCAL statement_timeout='5000ms'");
      const browser = await requireBrowserIdentity(request, tx, config, { write: true });
      const session = await tx.query(
        `SELECT s.id FROM web_session s JOIN app_user u ON u.id=s.user_id
         WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL
           AND s.expires_at>clock_timestamp() AND u.status='active' FOR SHARE OF s,u`,
        [browser.sessionId, browser.userId],
      );
      if (!session.rowCount) throw new AppError(401, 'LOGIN_REQUIRED', '登录已失效，请重新登录。');
      const actor = await requireBrowserIdentity(request, tx, config, { write: true });
      const result = await operation(tx, actor);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError(500, 'EXTERNAL_COMMAND_FAILED', '外部模型操作未完成，请稍后重试。');
    } finally {
      tx.release();
    }
  };
  const bounds = { bodyLimit: 64 * 1024 };
  if (runtime) {
    let recovery: NodeJS.Timeout | undefined;
    app.addHook('onReady', async () => {
      await service.recoverExpired();
      recovery = setInterval(() => {
        void service.recoverExpired().catch(() => {
          app.log.warn({ event: 'external_recovery_failed' }, '外部模型预占恢复失败。');
        });
      }, 15000).unref();
    });
    app.addHook('onClose', async () => clearInterval(recovery));
  }
  app.get(`${prefix}/setup`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    await read(request);
    return service.setup();
  });
  app.get(`${prefix}/conversations`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { cursor: after } = checked(
      z.object({ cursor: externalModelConversationCursorSchema.optional() }).strict(),
      request.query,
    );
    return externalModelConversationListSchema.parse(
      await service.conversations(await read(request), after),
    );
  });
  app.post(`${prefix}/conversations`, bounds, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return write(request, (tx, actor) =>
      service.create(tx, actor, checked(externalModelConversationInputSchema, request.body)),
    );
  });
  app.get(`${prefix}/conversations/:id/messages`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return externalModelExchangeListSchema.parse(
      await service.messages(await read(request), id(request), cursor(request)),
    );
  });
  app.post(`${prefix}/conversations/:id/messages`, bounds, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (runtime) {
      await requireBrowserIdentity(request, pool, config, { write: true });
      await service.recoverExpired();
    }
    const prepared = await write(request, (tx, actor) =>
      service.prepare(
        tx,
        actor,
        id(request),
        checked(externalModelMessageInputSchema, request.body),
      ),
    );
    return prepared.kind === 'replay' ? prepared.exchange : service.dispatch(prepared);
  });
  app.get(`${prefix}/words`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    await read(request);
    return externalModelWordListSchema.parse(await service.words());
  });
  app.post(`${prefix}/words`, bounds, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return write(request, (tx, actor) =>
      service.addWord(tx, actor, checked(externalModelWordInputSchema, request.body)),
    );
  });
  app.delete(`${prefix}/words/:id`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    await write(request, (tx, actor) => service.removeWord(tx, actor, id(request)));
    return reply.code(204).send();
  });
  app.get(`${prefix}/archive`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const actor = await read(request);
    const { day, cursor } = checked(
      z.object({ day: z.iso.date(), cursor: z.string().uuid().optional() }).strict(),
      request.query,
    );
    return externalModelArchivePageSchema.parse(await service.archiveDay(actor, day, cursor));
  });
  app.get(`${prefix}/exchanges/:id/archive`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return service.archive(await read(request), id(request));
  });
  app.post(`${prefix}/exchanges/:id/share`, bounds, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return write(request, (tx, actor) => {
      const input = checked(externalModelShareInputSchema, request.body);
      return service.share(tx, actor, id(request), input.conversationId, input.requestKey);
    });
  });
}
