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
  verificationCreateSchema,
  verificationInviteSchema,
  verificationMessageInputSchema,
  verificationRoomPageSchema,
  verificationSettingsInputSchema,
  verificationShareSchema,
  verificationLinkPageSchema,
  verificationReviewInputSchema,
  type BackendConfig,
  type BrowserIdentity,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { requireBrowserIdentity } from '../auth/session.js';
import { authorize } from '../auth/authorization.js';
import { usdToNano } from '../budget/meter.js';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import type { ExternalModelRuntime } from '../modelgw/external.js';
import { ExternalModels } from './service.js';
import { VerificationRooms, verificationWorkerStateId } from './verification-service.js';
import type { VerificationRuntime } from './verification-runtime.js';

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
  verificationRuntime?: VerificationRuntime,
  verificationPolling = false,
) {
  if (
    runtime &&
    (config.NODE_ENV !== 'test' || process.env.NODE_ENV !== 'test' || runtime.kind !== 'fixture')
  )
    throw new Error('EXTERNAL_MODEL_FIXTURE_TEST_ONLY');
  if (
    verificationRuntime &&
    (config.NODE_ENV !== 'test' ||
      process.env.NODE_ENV !== 'test' ||
      verificationRuntime.kind !== 'fixture')
  )
    throw new Error('VERIFICATION_FIXTURE_TEST_ONLY');
  const service = new ExternalModels(
    pool,
    blobStore,
    runtime,
    usdToNano(config.EXTERNAL_MODEL_MONTHLY_USD),
  );
  const prefix = '/api/external-model';
  const verification = new VerificationRooms(pool, service, verificationRuntime);
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
  const verify = '/api/verification';
  const openRoomStreams = new Set<() => void>();
  app.addHook('preClose', async () => {
    for (const close of openRoomStreams) close();
  });
  const schedule = (roomId: string) =>
    verification.kick(roomId, () => {
      app.log.warn({ event: 'verification_unavailable' }, '核实暂时暂停，请核对本地通道。');
    });
  if (verificationRuntime && verificationPolling) {
    let timer: ReturnType<typeof setInterval> | undefined;
    const pulse = async () => {
      await pool.query(
        `INSERT INTO verification_worker_state(id,worker_id,status) VALUES($1,$1,$2)
         ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,updated_at=clock_timestamp()`,
        [verificationWorkerStateId, verificationRuntime.status],
      );
      await verification.wakeReady(() => undefined);
    };
    app.addHook('onReady', async () => {
      await pulse();
      timer = setInterval(() => {
        void pulse().catch(() => undefined);
      }, 500).unref();
    });
    app.addHook('preClose', async () => clearInterval(timer));
  }
  app.addHook('onClose', async () => verification.close());
  app.get('/api/conversations/:id/verifications', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return verificationLinkPageSchema.parse(
      await verification.linkedRooms(await read(request), id(request), cursor(request)),
    );
  });
  const reviewScope = async (
    db: Pool | PoolClient,
    actor: BrowserIdentity,
    reviewId: string,
    lock = false,
  ) => {
    const { rows } = await db.query<{
      project_id: string;
      run_id: string;
      conversation_id: string;
      owner_user_id: string;
      status: string;
    }>(
      `SELECT c.project_id,c.run_id,c.conversation_id,c.status,p.owner_user_id
       FROM review_card c JOIN cert_project p ON p.id=c.project_id WHERE c.id=$1${lock ? ' FOR UPDATE OF c' : ''}`,
      [reviewId],
    );
    const review = rows[0];
    if (
      !review ||
      !authorize(actor, 'review.decide', {
        projectId: review.project_id,
        ownerUserId: review.owner_user_id,
        reviewKind: 'registration',
      })
    )
      throw new AppError(404, 'REVIEW_NOT_FOUND', '没有找到可访问的审核卡。');
    return review;
  };
  app.get('/api/reviews/:id/verifications', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const actor = await read(request);
    const reviewId = id(request);
    const scope = await reviewScope(pool, actor, reviewId);
    return verificationLinkPageSchema.parse(
      await verification.linkedRooms(actor, scope.conversation_id, cursor(request), {
        id: reviewId,
        runId: scope.run_id,
      }),
    );
  });
  app.post('/api/reviews/:id/verification', bounds, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const room = await write(request, async (db, actor) => {
      const input = checked(verificationReviewInputSchema, request.body);
      const reviewId = id(request);
      const review = await reviewScope(db, actor, reviewId, true);
      if (
        review.status !== 'pending' &&
        !(
          await db.query(
            'SELECT room_id FROM verification_link WHERE review_id=$1 AND room_id=$2 AND requester=$3',
            [reviewId, input.requestKey, actor.userId],
          )
        ).rowCount
      )
        throw new AppError(409, 'REVIEW_ALREADY_DECIDED', '该审核卡已处理，请刷新后查看核实历史。');
      return verification.create(
        db,
        actor,
        {
          question: input.question,
          requestKey: input.requestKey,
          projectId: review.project_id,
        },
        {
          kind: 'review',
          conversationId: review.conversation_id,
          runId: review.run_id,
          reviewId,
        },
      );
    });
    schedule(room.id);
    return room;
  });
  app.get(`${verify}/settings`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    await read(request);
    return verification.settings();
  });
  app.put(`${verify}/settings`, bounds, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    await write(request, (db, actor) =>
      verification.saveSettings(db, actor, checked(verificationSettingsInputSchema, request.body)),
    );
    return verification.settings();
  });
  app.post(`${verify}/settings/recheck`, bounds, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    await write(request, (db, actor) => verification.recheckChannel(db, actor));
    return reply.code(204).send();
  });
  app.get(`${verify}/rooms`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const paging = checked(
      z
        .object({
          cursor: externalModelConversationCursorSchema.optional(),
          query: z.string().trim().max(100).default(''),
        })
        .strict(),
      request.query,
    );
    const actor = await read(request);
    return verificationRoomPageSchema.parse(
      await verification.list(actor, paging.cursor, paging.query),
    );
  });
  app.post(`${verify}/rooms`, bounds, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const room = await write(request, (db, actor) =>
      verification.create(db, actor, checked(verificationCreateSchema, request.body)),
    );
    schedule(room.id);
    return room;
  });
  app.get(`${verify}/rooms/:id`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return verification.detail(await read(request), id(request), cursor(request));
  });
  app.get(`${verify}/rooms/:id/events`, async (request, reply) => {
    checked(z.object({}).strict(), request.query);
    const roomId = id(request);
    let revision = await verification.revision(await read(request), roomId);
    let pending = false;
    let active = true;
    let lastWrite = Date.now();
    function close() {
      if (!active) return;
      active = false;
      clearInterval(tick);
      openRoomStreams.delete(close);
      request.raw.removeListener('aborted', close);
      if (!reply.raw.destroyed) reply.raw.end();
    }
    function emit(text: string) {
      if (!active || reply.raw.destroyed) return close();
      lastWrite = Date.now();
      if (!reply.raw.write(text)) close();
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'x-accel-buffering': 'no',
    });
    openRoomStreams.add(close);
    request.raw.once('aborted', close);
    reply.raw.once('close', close);
    const tick = setInterval(() => {
      if (!active || pending) return;
      pending = true;
      void read(request)
        .then((actor) => verification.revision(actor, roomId))
        .then((next) => {
          if (revision !== next) {
            revision = next;
            emit('event: verification_updated\ndata: {}\n\n');
          } else if (Date.now() - lastWrite >= 15000) emit(': keepalive\n\n');
        })
        .catch(close)
        .finally(() => {
          pending = false;
        });
    }, 700).unref();
    emit('event: verification_updated\ndata: {}\n\n');
  });
  app.post(`${verify}/rooms/:id/posts`, bounds, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const roomId = id(request);
    await write(request, (db, actor) =>
      verification.speak(db, actor, roomId, checked(verificationMessageInputSchema, request.body)),
    );
    schedule(roomId);
    return reply.code(204).send();
  });
  app.post(`${verify}/rooms/:id/stop`, bounds, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const roomId = id(request);
    await write(request, (db, actor) => verification.stop(db, actor, roomId));
    schedule(roomId);
    return reply.code(204).send();
  });
  app.post(`${verify}/rooms/:id/models`, bounds, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const roomId = id(request);
    await write(request, (db, actor) =>
      verification.invite(db, actor, roomId, checked(verificationInviteSchema, request.body).model),
    );
    schedule(roomId);
    return reply.code(204).send();
  });
  app.post(`${verify}/rooms/:id/share`, bounds, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return write(request, (db, actor) => {
      const input = checked(verificationShareSchema, request.body);
      return verification.share(db, actor, id(request), input.conversationId, input.requestKey);
    });
  });
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
  const legacyFixtureRoutes = config.NODE_ENV === 'test' && process.env.NODE_ENV === 'test';
  if (legacyFixtureRoutes) {
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
  }
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
  if (legacyFixtureRoutes)
    app.post(`${prefix}/exchanges/:id/share`, bounds, async (request, reply) => {
      reply.header('cache-control', 'no-store');
      return write(request, (tx, actor) => {
        const input = checked(externalModelShareInputSchema, request.body);
        return service.share(tx, actor, id(request), input.conversationId, input.requestKey);
      });
    });
}
