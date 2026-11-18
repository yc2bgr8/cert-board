import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient, Notification } from 'pg';
import { conversationEventNotificationSchema, type BackendConfig } from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { CONVERSATION_EVENT_CHANNEL } from './storage.js';
import {
  readConversation,
  readPublicEvents,
  readMemberNotifications,
  withConversationReadSession,
} from './read.js';

export function parseEventCursor(value: unknown): number {
  if (value === undefined) return 0;
  if (
    typeof value !== 'string' ||
    !/^(?:0|[1-9][0-9]{0,15})$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new AppError(
      400,
      'EVENT_CURSOR_INVALID',
      '续读位置无效，请使用本对话事件返回的整数编号。',
    );
  return Number(value);
}
type Subscription = { conversationId: string | null; userId: string; wake(): void; close(): void };

export function createConversationStreams(pool: Pool, config: BackendConfig) {
  const subscriptions = new Set<Subscription>();
  const tasks = new Set<Promise<void>>();
  let listener: PoolClient | undefined;
  let connecting: Promise<void> | undefined;
  let stopped = false;
  const listenerFailed = () => {
    for (const subscription of subscriptions) subscription.close();
    if (listener) {
      listener.removeListener('error', listenerFailed);
      listener.removeListener('notification', notification);
      listener.release(true);
      listener = undefined;
    }
  };
  const notification = (message: Notification) => {
    if (message.channel !== CONVERSATION_EVENT_CHANNEL || !message.payload) return;
    let raw: unknown;
    try {
      raw = JSON.parse(message.payload);
    } catch {
      return;
    }
    const event = conversationEventNotificationSchema.safeParse(raw);
    if (!event.success) return;
    for (const subscription of subscriptions)
      if (
        subscription.conversationId === null ||
        subscription.conversationId === event.data.conversationId
      )
        subscription.wake();
  };
  async function listen() {
    if (stopped) throw new AppError(503, 'STREAM_UNAVAILABLE', '事件服务正在关闭，请稍后重连。');
    if (listener) return;
    if (!connecting)
      connecting = (async () => {
        const connection = await pool.connect();
        try {
          connection.on('error', listenerFailed);
          connection.on('notification', notification);
          await connection.query(`LISTEN ${CONVERSATION_EVENT_CHANNEL}`);
          if (stopped) throw new Error('stream_closed');
          listener = connection;
        } catch {
          connection.removeListener('error', listenerFailed);
          connection.removeListener('notification', notification);
          connection.release(true);
          throw new AppError(503, 'STREAM_UNAVAILABLE', '事件服务暂时不可用，请稍后重连。');
        }
      })().finally(() => {
        connecting = undefined;
      });
    await connecting;
  }
  async function open(
    request: FastifyRequest,
    reply: FastifyReply,
    conversationId: string | null,
    initialAfterSeq?: string,
  ) {
    if (conversationId === null && request.headers['last-event-id'] !== undefined)
      throw new AppError(
        400,
        'NOTIFICATION_CURSOR_UNSUPPORTED',
        '通知使用当前待处理快照，请重新连接以刷新；此接口不使用对话序号。',
      );
    let cursor =
      conversationId === null
        ? 0
        : parseEventCursor(request.headers['last-event-id'] ?? initialAfterSeq);
    const userId = await withConversationReadSession(pool, config, request, async (tx, actor) => {
      if (conversationId) {
        const conversation = await readConversation(tx, actor, conversationId);
        if (cursor > conversation.lastEventSeq)
          throw new AppError(
            409,
            'EVENT_CURSOR_AHEAD',
            '续读位置超出当前对话记录，请重新读取对话。',
          );
      }
      return actor.userId;
    });
    if (
      subscriptions.size >= 50 ||
      [...subscriptions].filter((entry) => entry.userId === userId).length >= 5
    )
      throw new AppError(429, 'STREAM_LIMIT', '打开的事件连接过多，请关闭多余页面后重试。');
    let closed = false,
      pumping = false,
      dirty = true,
      started = false;
    let lastSnapshot: string | undefined,
      lastWrite = Date.now();
    let timer: ReturnType<typeof setInterval> | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      subscriptions.delete(subscription);
      reply.raw.removeListener('close', close);
      request.raw.removeListener('aborted', close);
      if (started && !reply.raw.destroyed) reply.raw.end();
    };
    async function write(frame: string) {
      if (closed || reply.raw.destroyed) {
        close();
        return;
      }
      lastWrite = Date.now();
      if (reply.raw.write(frame)) return;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timeout);
          reply.raw.removeListener('drain', finish);
          reply.raw.removeListener('close', finish);
          resolve();
        };
        const timeout = setTimeout(() => {
          close();
          finish();
        }, 5000);
        reply.raw.once('drain', finish);
        reply.raw.once('close', finish);
      });
    }
    async function pump() {
      if (pumping || closed || !started) return;
      pumping = true;
      try {
        while (dirty && !closed) {
          dirty = false;
          if (conversationId) {
            const events = await withConversationReadSession(pool, config, request, (tx, actor) =>
              readPublicEvents(tx, actor, conversationId, cursor),
            );
            for (const event of events) {
              if (closed) break;
              await write(
                `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              );
              if (!closed) cursor = event.seq;
            }
            if (events.length === 50) dirty = true;
          } else {
            const snapshot = await withConversationReadSession(pool, config, request, (tx, actor) =>
              readMemberNotifications(tx, actor),
            );
            const fingerprint = JSON.stringify({
              items: snapshot.items,
              truncated: snapshot.truncated,
            });
            if (fingerprint !== lastSnapshot) {
              await write(`event: pending_snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
              lastSnapshot = fingerprint;
            }
          }
          if (!closed && Date.now() - lastWrite >= 15000) await write(': keepalive\n\n');
        }
      } catch {
        close();
      } finally {
        pumping = false;
      }
    }
    const wake = () => {
      dirty = true;
      if (!started || pumping || closed) return;
      const task = pump();
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    };
    const subscription: Subscription = { conversationId, userId, wake, close };
    subscriptions.add(subscription);
    reply.raw.once('close', close);
    request.raw.once('aborted', close);
    try {
      await listen();
      // LISTEN 已生效后再次验证，首轮回补和之后的通知由同一串行泵读取。
      await withConversationReadSession(pool, config, request, async (tx, actor) => {
        if (conversationId) await readConversation(tx, actor, conversationId);
      });
      if (closed || stopped)
        throw new AppError(503, 'STREAM_UNAVAILABLE', '事件连接已关闭，请重新打开。');
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'same-origin',
        'x-accel-buffering': 'no',
      });
      started = true;
      reply.raw.flushHeaders();
      timer = setInterval(wake, 1000);
      timer.unref();
      wake();
    } catch (error) {
      close();
      throw error;
    }
  }
  return {
    open,
    async close() {
      stopped = true;
      for (const subscription of subscriptions) subscription.close();
      await connecting?.catch(() => undefined);
      await Promise.allSettled([...tasks]);
      if (listener) {
        const connection = listener;
        listener = undefined;
        connection.removeListener('notification', notification);
        await connection.query(`UNLISTEN ${CONVERSATION_EVENT_CHANNEL}`).catch(() => undefined);
        connection.removeListener('error', listenerFailed);
        connection.release();
      }
    },
  };
}
