import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  appendConversationMessageSchema,
  appendConversationEventSchema,
  conversationAppendResultSchema,
  conversationMessageRecordSchema,
  conversationEventRecordSchema,
  conversationHistoryOptionsSchema,
  conversationMessageListSchema,
  conversationEventListSchema,
  conversationEventNotificationSchema,
  projectIdSchema,
  serviceIdentitySchema,
  roleBindingSchema,
  type ServiceIdentity,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { authorize } from '../auth/authorization.js';

type Kind = 'message' | 'event';
export const CONVERSATION_EVENT_CHANNEL = 'cert_board_conversation_events';
const denied = () =>
  new AppError(404, 'CONVERSATION_NOT_FOUND', '未找到可访问的对话，请从自己的项目重新打开。');
const invalid = () =>
  new AppError(
    400,
    'CONVERSATION_CONTENT_INVALID',
    '对话内容、请求编号或分页无效，请缩小输入并只保留业务字段。',
  );
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
async function lockContext(tx: PoolClient, runId: string, userId: string) {
  const located = (
    await tx.query<{ conversation_id: string; goal_id: string | null }>(
      'SELECT conversation_id,goal_id FROM run WHERE id=$1 AND user_id=$2',
      [runId, userId],
    )
  ).rows[0];
  if (!located) throw denied();
  const user = await tx.query("SELECT id FROM app_user WHERE id=$1 AND status='active' FOR SHARE", [
    userId,
  ]);
  if (!user.rowCount) throw denied();
  if (located.goal_id)
    await tx.query('SELECT id FROM goal WHERE id=$1 FOR SHARE', [located.goal_id]);
  const conversation = (
    await tx.query<{
      id: string;
      last_message_seq: string;
      last_event_seq: string;
      max_data_level: string;
    }>(
      'SELECT id,last_message_seq,last_event_seq,max_data_level FROM conversation WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [located.conversation_id, userId],
    )
  ).rows[0];
  const run = (
    await tx.query<{ conversation_id: string; max_data_level: string }>(
      'SELECT conversation_id,max_data_level FROM run WHERE id=$1 AND user_id=$2 FOR SHARE',
      [runId, userId],
    )
  ).rows[0];
  if (!conversation || !run || run.conversation_id !== conversation.id) throw denied();
  return {
    ...conversation,
    dataLevel:
      conversation.max_data_level === 'confidential' || run.max_data_level === 'confidential'
        ? 'confidential'
        : 'internal',
  };
}
async function append(pool: Pool, kind: Kind, input: unknown) {
  const parsed =
    kind === 'message'
      ? appendConversationMessageSchema.safeParse(input)
      : appendConversationEventSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  const { runId, userId, requestKey } = parsed.data;
  const value = 'message' in parsed.data ? parsed.data.message : parsed.data.event;
  const text = JSON.stringify(canonical(value));
  const hash = createHash('sha256').update(text).digest('hex');
  // 表名只由此模块的封闭联合类型选择，不接收请求中的SQL标识符。
  const table = kind === 'message' ? 'conversation_message' : 'conversation_event';
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const context = await lockContext(tx, runId, userId);
    const previous = (
      await tx.query<{ id: string; seq: string; content_hash: string }>(
        `SELECT id,seq,content_hash FROM ${table} WHERE run_id=$1 AND request_key=$2`,
        [runId, requestKey],
      )
    ).rows[0];
    if (previous) {
      if (previous.content_hash !== hash)
        throw new AppError(
          409,
          'CONVERSATION_REQUEST_CONFLICT',
          '同一请求编号已保存不同内容，请使用新的请求编号。',
        );
      await tx.query('COMMIT');
      return conversationAppendResultSchema.parse({
        id: previous.id,
        conversationId: context.id,
        runId,
        seq: Number(previous.seq),
        replayed: true,
      });
    }
    const seq = Number(kind === 'message' ? context.last_message_seq : context.last_event_seq) + 1;
    if (!Number.isSafeInteger(seq))
      throw new AppError(409, 'CONVERSATION_SEQUENCE_LIMIT', '对话记录已达上限，请建立新对话。');
    const values: unknown[] = [runId, context.id, userId, requestKey, seq, hash, context.dataLevel];
    let columns: string, parameters: string;
    if ('message' in parsed.data) {
      columns = 'message_json';
      parameters = '$8';
      values.push(text);
    } else {
      columns = 'type,payload_json';
      parameters = '$8,$9';
      values.push(parsed.data.event.type, JSON.stringify(canonical(parsed.data.event.payload)));
    }
    const saved = (
      await tx.query<{ id: string }>(
        `INSERT INTO ${table}
      (run_id,conversation_id,user_id,request_key,seq,content_hash,data_level,${columns})
      VALUES($1,$2,$3,$4,$5,$6,$7,${parameters}) RETURNING id`,
        values,
      )
    ).rows[0]!;
    if (kind === 'event') {
      const notification = conversationEventNotificationSchema.parse({
        conversationId: context.id,
        eventId: saved.id,
        seq,
      });
      // PostgreSQL仅在本事务成功提交后投递；重放分支不再发通知。
      await tx.query('SELECT pg_notify($1,$2)', [
        CONVERSATION_EVENT_CHANNEL,
        JSON.stringify(notification),
      ]);
    }
    await tx.query('COMMIT');
    return conversationAppendResultSchema.parse({
      id: saved.id,
      conversationId: context.id,
      runId,
      seq,
      replayed: false,
    });
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError(
      500,
      'CONVERSATION_APPEND_FAILED',
      '对话记录未保存，序号已回滚，请核对运行状态后重试。',
    );
  } finally {
    tx.release();
  }
}
export function appendConversationMessage(pool: Pool, input: unknown) {
  return append(pool, 'message', input);
}
export function appendConversationEvent(pool: Pool, input: unknown) {
  return append(pool, 'event', input);
}

async function list(
  pool: Pool,
  kind: Kind,
  identity: ServiceIdentity,
  conversationId: string,
  options: unknown,
) {
  const actor = serviceIdentitySchema.safeParse(identity);
  const page = conversationHistoryOptionsSchema.safeParse(options);
  if (!actor.success || !page.success || !projectIdSchema.safeParse(conversationId).success)
    throw invalid();
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    if (
      !(
        await tx.query("SELECT id FROM app_user WHERE id=$1 AND status='active' FOR SHARE", [
          actor.data.userId,
        ])
      ).rowCount
    )
      throw denied();
    const bindings = await tx.query(
      'SELECT role,scope_type AS "scopeType",scope_id AS "scopeId" FROM role_binding WHERE user_id=$1',
      [actor.data.userId],
    );
    const currentActor = {
      ...actor.data,
      roles: bindings.rows.map((row) => roleBindingSchema.parse(row)),
    };
    const conversation = (
      await tx.query<{ user_id: string; project_id: string | null; max_data_level: string }>(
        'SELECT user_id,project_id,max_data_level FROM conversation WHERE id=$1 AND user_id=$2 FOR SHARE',
        [conversationId, currentActor.userId],
      )
    ).rows[0];
    if (
      !conversation ||
      !authorize(currentActor, 'conversation.read', {
        projectId: conversation.project_id,
        ownerUserId: conversation.user_id,
      })
    )
      throw denied();
    if (conversation.project_id) {
      const project = (
        await tx.query<{ owner_user_id: string }>(
          'SELECT owner_user_id FROM cert_project WHERE id=$1',
          [conversation.project_id],
        )
      ).rows[0];
      if (
        !project ||
        !authorize(currentActor, 'project.read', {
          projectId: conversation.project_id,
          ownerUserId: project.owner_user_id,
        })
      )
        throw denied();
    }
    const table = kind === 'message' ? 'conversation_message' : 'conversation_event';
    const data =
      kind === 'message'
        ? 'message_json AS message'
        : "jsonb_build_object('type',type,'payload',payload_json) AS event";
    const rows = (
      await tx.query<Record<string, unknown>>(
        `SELECT id,conversation_id AS "conversationId",
      run_id AS "runId",user_id AS "userId",seq,created_at AS "createdAt",
      GREATEST(data_level,$4::document_data_level) AS "dataLevel",${data}
      FROM ${table} WHERE conversation_id=$1 AND seq>$2 ORDER BY seq LIMIT $3`,
        [conversationId, page.data.afterSeq, page.data.limit + 1, conversation.max_data_level],
      )
    ).rows;
    const hasMore = rows.length > page.data.limit;
    const items = rows.slice(0, page.data.limit).map((row) => ({
      ...row,
      seq: Number(row.seq),
      createdAt: (row.createdAt as Date).toISOString(),
    }));
    await tx.query('COMMIT');
    return { items, hasMore, nextAfterSeq: hasMore ? items.at(-1)!.seq : null };
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'CONVERSATION_READ_FAILED', '对话记录读取失败，请稍后重新打开。');
  } finally {
    tx.release();
  }
}
export async function listConversationMessages(
  pool: Pool,
  identity: ServiceIdentity,
  conversationId: string,
  options: unknown = {},
) {
  const result = await list(pool, 'message', identity, conversationId, options);
  return conversationMessageListSchema.parse({
    ...result,
    items: result.items.map((item) => conversationMessageRecordSchema.parse(item)),
  });
}
export async function listConversationEvents(
  pool: Pool,
  identity: ServiceIdentity,
  conversationId: string,
  options: unknown = {},
) {
  const result = await list(pool, 'event', identity, conversationId, options);
  return conversationEventListSchema.parse({
    ...result,
    items: result.items.map((item) => conversationEventRecordSchema.parse(item)),
  });
}
