import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyRequest,
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
} from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  browserIdentitySchema,
  conversationStopInputSchema,
  type BackendConfig,
  type BrowserIdentity,
} from '@cert-board/shared';
import { requireBrowserIdentity } from '../auth/session.js';
import { authorizeRunStop, notifyRunStop } from '../runs/control.js';
import {
  createConversationTx,
  sendConversationMessageTx,
  changeConversationModeTx,
  answerQuestionTx,
  stopConversationRunTx,
  preflightConversationStopTx,
} from '../conversations/commands.js';
import { AppError } from './errors.js';
import { saveHumanFeedback } from '../conversations/human-feedback.js';

export function registerConversationWriteRoutes<Logger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    Logger
  >,
  pool: Pool,
  config: BackendConfig,
) {
  const params = z.object({ id: z.string().uuid() }).strict();
  const identifier = (request: FastifyRequest) => {
    const parsed = params.safeParse(request.params);
    if (!parsed.success)
      throw new AppError(400, 'CONVERSATION_ID_INVALID', '项目或对话编号无效，请重新打开。');
    return parsed.data.id;
  };
  // 写入必须从真实浏览器请求进入；不导出可由Agent构造身份的HTTP决定入口。
  const browserTransaction = async <T>(
    request: FastifyRequest,
    operation: (tx: PoolClient, actor: BrowserIdentity) => Promise<T>,
  ) => {
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      const first = await requireBrowserIdentity(request, tx, config, { write: true });
      const session = await tx.query(
        `SELECT s.id FROM web_session s JOIN app_user u ON u.id=s.user_id
        WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
          AND u.status='active' FOR SHARE OF s,u`,
        [first.sessionId, first.userId],
      );
      if (!session.rowCount) throw new AppError(401, 'LOGIN_REQUIRED', '登录已失效，请重新登录。');
      const actor = browserIdentitySchema.parse(
        await requireBrowserIdentity(request, tx, config, { write: true }),
      );
      const result = await operation(tx, actor);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError(
        500,
        'CONVERSATION_COMMAND_FAILED',
        '本次对话操作未完成，消息和状态修改已回滚，请保留原文并重试。',
      );
    } finally {
      tx.release();
    }
  };
  const options = { bodyLimit: 65536 };
  app.post('/api/projects/:id/conversations', options, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return browserTransaction(request, (tx, actor) =>
      createConversationTx(tx, actor, request.body, identifier(request)),
    );
  });
  app.post('/api/conversations', options, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return browserTransaction(request, (tx, actor) =>
      createConversationTx(tx, actor, request.body),
    );
  });
  app.post('/api/conversations/:id/messages', options, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return browserTransaction(request, (tx, actor) =>
      sendConversationMessageTx(tx, actor, identifier(request), request.body),
    );
  });
  app.post('/api/conversations/:id/feedback', { bodyLimit: 4_096 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return browserTransaction(request, (tx, actor) =>
      saveHumanFeedback(tx, actor, identifier(request), request.body),
    );
  });
  app.patch('/api/conversations/:id/permission-mode', options, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return browserTransaction(request, (tx, actor) =>
      changeConversationModeTx(tx, actor, identifier(request), request.body),
    );
  });
  app.post('/api/conversations/:id/answers', options, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return browserTransaction(request, (tx, actor) =>
      answerQuestionTx(tx, actor, identifier(request), request.body),
    );
  });
  app.post('/api/conversations/:id/stop', options, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const conversationId = identifier(request);
    const input = conversationStopInputSchema.safeParse(request.body);
    if (!input.success)
      throw new AppError(400, 'CONVERSATION_STOP_INVALID', '停止请求需要当前运行编号和请求编号。');
    let notifyUserId: string | undefined;
    const result = await browserTransaction(request, async (tx, actor) => {
      const replay = await preflightConversationStopTx(tx, actor, conversationId, input.data);
      if (replay) return replay;
      await authorizeRunStop(tx, actor, input.data.runId);
      // 幂等意图先锁定，尚未拿业务对象写锁；通知由独立连接立即提交。
      await notifyRunStop(pool, input.data.runId, actor.userId).catch(() => undefined);
      notifyUserId = actor.userId;
      return stopConversationRunTx(tx, actor, conversationId, input.data);
    });
    if (notifyUserId)
      await notifyRunStop(pool, input.data.runId, notifyUserId).catch(() => undefined);
    return result;
  });
}
