import type {
  FastifyInstance,
  FastifyBaseLogger,
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
} from 'fastify';
import type { Pool } from 'pg';
import {
  conversationReadParamsSchema,
  conversationEventQuerySchema,
  conversationListQuerySchema,
  conversationPublicHistoryQuerySchema,
  type BackendConfig,
} from '@cert-board/shared';
import { AppError } from './errors.js';
import {
  readConversation,
  readConversationList,
  readPublicMessages,
  withConversationReadSession,
} from '../conversations/read.js';
import { createConversationStreams } from '../conversations/stream.js';
import { readDailyDigest } from '../deadlines/daily-digest.js';

export function registerConversationReadRoutes<Logger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    Logger
  >,
  pool: Pool,
  config: BackendConfig,
) {
  const id = (value: unknown) => {
    const parsed = conversationReadParamsSchema.safeParse(value);
    if (!parsed.success)
      throw new AppError(400, 'CONVERSATION_ID_INVALID', '对话或项目编号无效，请从列表重新打开。');
    return parsed.data.id;
  };
  const streams = createConversationStreams(pool, config);
  app.addHook('preClose', async () => streams.close());
  for (const path of ['/api/conversations', '/api/projects/:id/conversations'])
    app.get(path, async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const options = conversationListQuerySchema.safeParse(request.query);
      if (!options.success)
        throw new AppError(
          400,
          'CONVERSATION_PAGINATION_INVALID',
          '列表分页参数无效，请使用返回的续读编号。',
        );
      return withConversationReadSession(pool, config, request, (tx, actor) =>
        readConversationList(tx, actor, {
          limit: options.data.limit,
          scope: options.data.scope,
          ...(options.data.cursor ? { cursor: options.data.cursor } : {}),
          ...(path.includes('/projects/') ? { projectId: id(request.params) } : {}),
        }),
      );
    });
  app.get('/api/conversations/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return withConversationReadSession(pool, config, request, (tx, actor) =>
      readConversation(tx, actor, id(request.params)),
    );
  });
  app.get('/api/conversations/:id/messages', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const options = conversationPublicHistoryQuerySchema.safeParse(request.query);
    if (!options.success)
      throw new AppError(
        400,
        'CONVERSATION_PAGINATION_INVALID',
        '消息分页参数无效，请使用返回的续读序号。',
      );
    return withConversationReadSession(pool, config, request, (tx, actor) =>
      readPublicMessages(tx, actor, id(request.params), options.data),
    );
  });
  app.get('/api/conversations/:id/events', async (request, reply) => {
    const query = conversationEventQuerySchema.safeParse(request.query);
    if (!query.success)
      throw new AppError(
        400,
        'EVENT_QUERY_INVALID',
        '事件地址只接受整数 afterSeq 首次续读位置，不接受凭据或其他参数。',
      );
    return streams.open(request, reply, id(request.params), query.data.afterSeq);
  });
  app.get('/api/me/stream', async (request, reply) => {
    if (Object.keys(request.query as object).length)
      throw new AppError(400, 'EVENT_QUERY_INVALID', '通知地址不接受查询参数。');
    return streams.open(request, reply, null);
  });
  app.get('/api/me/daily-digest', async (request, reply) => {
    if (Object.keys(request.query as object).length)
      throw new AppError(
        400,
        'DAILY_DIGEST_QUERY_INVALID',
        '日摘要按当前登录账号读取，不接受查询参数。',
      );
    reply.header('cache-control', 'no-store');
    return withConversationReadSession(pool, config, request, (tx, actor) =>
      readDailyDigest(tx, actor.userId),
    );
  });
}
