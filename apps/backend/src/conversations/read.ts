import type { FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  conversationPublicRecordSchema,
  conversationPublicListSchema,
  conversationPublicHistorySchema,
  conversationPublicEventSchema,
  toolApprovalPendingResultSchema,
  memberNotificationSnapshotSchema,
  type BackendConfig,
  type BrowserIdentity,
  type ConversationPublicEvent,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { requireBrowserIdentity } from '../auth/session.js';
import { toolLabel } from '../agent/tool-progress.js';

type Database = Pick<Pool, 'query'>;
const missing = () =>
  new AppError(404, 'CONVERSATION_NOT_FOUND', '未找到可访问的对话，请从项目重新打开。');
const fields = `c.id,c.project_id AS "projectId",c.goal_id AS "goalId",c.user_id AS "userId",
 u.display_name AS "ownerName",c.title,c.agent_code AS "agentCode",c.permission_mode AS "permissionMode",
 c.status,c.max_data_level AS "maxDataLevel",c.version,c.permission_version AS "permissionVersion",c.current_run_id AS "currentRunId",c.last_message_seq AS "lastMessageSeq",
 c.last_event_seq AS "lastEventSeq",c.created_at AS "createdAt",c.updated_at AS "updatedAt"`;
function record(row: Record<string, unknown>, actor: BrowserIdentity) {
  return conversationPublicRecordSchema.parse({
    ...row,
    lastMessageSeq: Number(row.lastMessageSeq),
    lastEventSeq: Number(row.lastEventSeq),
    createdAt: (row.createdAt as Date).toISOString(),
    updatedAt: (row.updatedAt as Date).toISOString(),
    canWrite: row.userId === actor.userId && row.status === 'active',
  });
}
// 每次读取均在短事务中重新验证浏览器会话。长连接本身不持有任何授权锁。
export async function withConversationReadSession<T>(
  pool: Pool,
  config: BackendConfig,
  request: FastifyRequest,
  action: (tx: PoolClient, actor: BrowserIdentity) => Promise<T>,
): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query("SET LOCAL statement_timeout='5000ms'");
    const first = await requireBrowserIdentity(request, tx, config);
    const active = await tx.query(
      `SELECT s.id FROM web_session s JOIN app_user u ON u.id=s.user_id
       WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
         AND u.status='active' FOR SHARE OF s,u`,
      [first.sessionId, first.userId],
    );
    if (active.rowCount !== 1)
      throw new AppError(401, 'LOGIN_REQUIRED', '登录已失效，请重新登录。');
    const actor = await requireBrowserIdentity(request, tx, config);
    const result = await action(tx, actor);
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'CONVERSATION_READ_FAILED', '对话记录读取失败，请稍后重新打开。');
  } finally {
    tx.release();
  }
}
export async function readConversation(database: Database, actor: BrowserIdentity, id: string) {
  const row = (
    await database.query<Record<string, unknown>>(
      `SELECT ${fields} FROM conversation c JOIN app_user u ON u.id=c.user_id WHERE c.id=$1`,
      [id],
    )
  ).rows[0];
  if (!row) throw missing();
  return record(row, actor);
}
export async function readConversationList(
  database: Database,
  actor: BrowserIdentity,
  options: { cursor?: string; limit: number; scope: 'unassigned' | 'all'; projectId?: string },
) {
  if (
    options.projectId &&
    !(await database.query('SELECT id FROM cert_project WHERE id=$1', [options.projectId])).rowCount
  )
    throw missing();
  const condition = options.projectId
    ? 'c.project_id=$1::uuid'
    : options.scope === 'all'
      ? '$1::uuid IS NULL'
      : '$1::uuid IS NULL AND c.project_id IS NULL';
  const rows = (
    await database.query<Record<string, unknown>>(
      `SELECT ${fields} FROM conversation c JOIN app_user u ON u.id=c.user_id
     WHERE ${condition} AND ($2::uuid IS NULL OR c.id>$2::uuid) ORDER BY c.id LIMIT $3`,
      [options.projectId ?? null, options.cursor ?? null, options.limit + 1],
    )
  ).rows;
  const items = rows.slice(0, options.limit).map((row) => record(row, actor));
  return conversationPublicListSchema.parse({
    items,
    hasMore: rows.length > options.limit,
    nextCursor: rows.length > options.limit ? items.at(-1)!.id : null,
  });
}
export async function readPublicMessages(
  database: Database,
  actor: BrowserIdentity,
  id: string,
  options: { afterSeq: number; limit: number },
) {
  await readConversation(database, actor, id);
  const rows = (
    await database.query<Record<string, unknown>>(
      `WITH candidates AS (
       SELECT id,run_id AS "runId",user_id AS "userId",seq,created_at AS "createdAt",
       message_json->>'role' AS role,message_json->>'content' AS text
       FROM conversation_message WHERE conversation_id=$1 AND seq>$2
         AND message_json->>'role' IN ('user','assistant') AND jsonb_typeof(message_json->'content')='string'
       ORDER BY seq LIMIT $3
     ), bounded AS (
       SELECT *,sum(octet_length(text)) OVER(ORDER BY seq) AS bytes,row_number() OVER(ORDER BY seq) AS position FROM candidates
     ) SELECT id,"runId","userId",seq,"createdAt",role,text FROM bounded
       WHERE bytes<=262144 OR position=1 ORDER BY seq`,
      [id, options.afterSeq, options.limit],
    )
  ).rows;
  const items = rows.map((row) => ({
    ...row,
    seq: Number(row.seq),
    createdAt: (row.createdAt as Date).toISOString(),
  }));
  const last = items.at(-1)?.seq ?? options.afterSeq;
  const more =
    (
      await database.query(
        `SELECT id FROM conversation_message WHERE conversation_id=$1 AND seq>$2
     AND message_json->>'role' IN ('user','assistant') AND jsonb_typeof(message_json->'content')='string' LIMIT 1`,
        [id, last],
      )
    ).rowCount === 1;
  return conversationPublicHistorySchema.parse({
    items,
    hasMore: more,
    nextAfterSeq: more ? last : null,
  });
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const bounded = (value: unknown, maximum: number) =>
  typeof value === 'string' && value.length <= maximum ? value : undefined;
const uuid = (value: unknown) =>
  z.string().uuid().safeParse(value).success ? (value as string) : undefined;
const call = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
const optional = (name: string, value: unknown) => (value === undefined ? {} : { [name]: value });
function publicRunSummary(status: unknown, reason: unknown) {
  if (status === 'waiting' && reason === 'VERIFICATION_WAITING')
    return '核实正在进行。结论出来后会在本对话继续。';
  if (
    reason === 'BUDGET_BLOCKED' ||
    reason === 'MODEL_METERING_BLOCKED' ||
    reason === 'MODEL_USAGE_INCOMPLETE'
  )
    return '用量或账本状态需要核对。本轮已停止派发模型请求。';
  if (status === 'budget_exhausted') {
    if (reason === 'BUDGET_LIMIT_REACHED') return '本轮达到预算限制，请核对已完成事项和预算。';
    return '预算或用量计量限制已停止本轮，请先核对用量后继续。';
  }
  if (status === 'failed' && reason === 'MODEL_UPSTREAM_FAILED')
    return '上游模型请求失败，已保留计量记录。请核对用量和本轮工具记录。';
  if (status === 'stopped' && reason === 'REVIEW_NOT_SUBMITTED')
    return '本轮结束时未提交审核。请核对已保存的改动和未完成事项。';
  return '运行状态已更新。';
}
export function projectConversationEvent(row: {
  id: string;
  conversationId: string;
  runId: string;
  seq: number;
  createdAt: string;
  type: string;
  payload: unknown;
}): ConversationPublicEvent {
  const p = object(row.payload);
  let payload: Record<string, unknown>;
  let type = row.type;
  switch (type) {
    case 'user_message':
    case 'assistant_message':
      payload = {
        content: bounded(p.content ?? p.text, 262144) ?? '',
        ...optional('messageId', uuid(p.messageId)),
        ...(type === 'user_message' ? optional('steeringId', uuid(p.steeringId)) : {}),
      };
      break;
    case 'tool_started':
    case 'tool_completed':
    case 'tool_failed': {
      const name =
        typeof p.name === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(p.name) ? p.name : undefined;
      const label = toolLabel(name ?? '');
      const historical = toolApprovalPendingResultSchema.safeParse(p.data);
      const awaitingApproval =
        type === 'tool_completed' &&
        (p.awaitingApproval === true ||
          (historical.success && historical.data.status === 'pending'));
      payload = {
        ...optional('name', name),
        ...optional('callId', call(p.callId)),
        ...(awaitingApproval ? { awaitingApproval: true } : {}),
        summary: awaitingApproval
          ? '等待发起人在浏览器批准后继续'
          : `${label}${type === 'tool_failed' ? '未完成' : type === 'tool_completed' ? '已完成' : ''}`,
      };
      break;
    }
    case 'plan_updated': {
      const steps = Array.isArray(p.steps)
        ? p.steps
            .slice(0, 12)
            .map(object)
            .map((step) => ({
              title: bounded(step.title, 160) ?? '待核对步骤',
              status: ['pending', 'running', 'completed'].includes(String(step.status))
                ? step.status
                : 'pending',
            }))
        : [];
      payload = { steps, progress: bounded(p.progress, 400) ?? '' };
      break;
    }
    case 'question':
      payload = {
        ...optional('questionId', call(p.questionId)),
        question: bounded(p.question, 1200) ?? '请打开原对话核对问题。',
        options: Array.isArray(p.options)
          ? p.options.filter((item) => bounded(item, 160) !== undefined).slice(0, 6)
          : [],
      };
      break;
    case 'approval_requested':
      payload = {
        ...optional('approvalId', uuid(p.approvalId)),
        summary: '等待发起人在浏览器处理批准请求。',
      };
      break;
    case 'approval_resolved':
      payload = {
        ...optional('approvalId', uuid(p.approvalId)),
        ...optional('executed', typeof p.executed === 'boolean' ? p.executed : undefined),
        summary: '批准请求的处理结果已记录，请从原批准卡核对。',
      };
      break;
    case 'review_submitted':
      payload = { ...optional('reviewId', uuid(p.reviewId)), summary: '交付已提交审核。' };
      break;
    case 'run_status':
      payload = {
        ...optional(
          'status',
          [
            'queued',
            'running',
            'waiting',
            'completed',
            'failed',
            'stopped',
            'budget_exhausted',
          ].includes(String(p.status))
            ? p.status
            : undefined,
        ),
        ...optional('reviewId', uuid(p.reviewId)),
        ...optional('approvalId', uuid(p.approvalId)),
        ...optional('questionId', call(p.questionId)),
        ...optional('verificationRoomId', uuid(p.verificationRoomId)),
        ...optional(
          'pendingSteeringCount',
          typeof p.pendingSteeringCount === 'number' &&
            Number.isSafeInteger(p.pendingSteeringCount) &&
            p.pendingSteeringCount >= 0
            ? p.pendingSteeringCount
            : undefined,
        ),
        summary: publicRunSummary(p.status, p.reasonCode),
      };
      break;
    case 'model_started':
      payload = { summary: '正在生成回复。' };
      break;
    case 'changes':
      payload = {
        summary: '工作区改动已记录。',
        ...optional('workspaceVersion', uuid(p.workspaceVersion)),
      };
      break;
    case 'question_answered':
      payload = {
        summary: '发起人的回答已记录。',
        ...optional('questionId', call(p.questionId)),
        ...optional('newRunId', uuid(p.newRunId)),
      };
      break;
    case 'permission_changed':
      payload = {
        summary: '对话权限模式已更新，下一次工具调用按新模式执行。',
        ...optional(
          'permissionMode',
          ['read_only', 'ask', 'full'].includes(String(p.permissionMode))
            ? p.permissionMode
            : undefined,
        ),
        ...optional(
          'permissionVersion',
          typeof p.permissionVersion === 'number' &&
            Number.isSafeInteger(p.permissionVersion) &&
            p.permissionVersion > 0
            ? p.permissionVersion
            : undefined,
        ),
      };
      break;
    default:
      type = 'progress';
      payload = { summary: '工作进度已更新。' };
  }
  return conversationPublicEventSchema.parse({
    id: row.id,
    conversationId: row.conversationId,
    runId: row.runId,
    seq: row.seq,
    createdAt: row.createdAt,
    type,
    payload,
  });
}
export async function readPublicEvents(
  database: Database,
  actor: BrowserIdentity,
  id: string,
  afterSeq: number,
) {
  const conversation = await readConversation(database, actor, id);
  if (afterSeq > conversation.lastEventSeq)
    throw new AppError(409, 'EVENT_CURSOR_AHEAD', '续读位置超出当前对话记录，请重新读取对话。');
  const rows = (
    await database.query<{
      id: string;
      conversationId: string;
      runId: string;
      seq: string;
      createdAt: Date;
      type: string;
      payload: unknown;
    }>(
      `SELECT id,conversation_id AS "conversationId",run_id AS "runId",seq,created_at AS "createdAt",type,payload_json AS payload
     FROM conversation_event WHERE conversation_id=$1 AND seq>$2 ORDER BY seq LIMIT 50`,
      [id, afterSeq],
    )
  ).rows;
  return rows.map((row) =>
    projectConversationEvent({
      ...row,
      seq: Number(row.seq),
      createdAt: row.createdAt.toISOString(),
    }),
  );
}
export async function readMemberNotifications(database: Database, actor: BrowserIdentity) {
  const noticeLimit = 50;
  const skillLimit = 10;
  const rows = (
    await database.query<{
      id: string;
      kind: string;
      conversationId: string | null;
      projectId: string | null;
      createdAt: Date;
      deadline: unknown;
      verification: unknown;
      skillRollback: unknown;
      knowledgeReview: unknown;
    }>(
      `WITH pending AS (
       SELECT a.id,'approval'::text AS kind,a.conversation_id,a.project_id,a.created_at,NULL::jsonb AS deadline FROM tool_approval a
       JOIN run r ON r.id=a.run_id JOIN conversation c ON c.id=a.conversation_id
       WHERE a.user_id=$1 AND a.status='pending' AND c.status='active' AND r.status IN ('running','waiting')
       UNION ALL
       SELECT v.id,'review',v.conversation_id,v.project_id,v.created_at,NULL FROM review_card v WHERE v.status='pending'
       UNION ALL
       SELECT p.id,'proposal',p.conversation_id,p.project_id,p.created_at,NULL FROM proposal p WHERE p.status='proposed'
       UNION ALL
       SELECT i.id,'question',r.conversation_id,r.project_id,i.created_at,NULL FROM tool_invocation i
       JOIN run r ON r.id=i.run_id JOIN conversation c ON c.id=r.conversation_id
       WHERE r.user_id=$1 AND r.status='waiting' AND c.status='active' AND c.current_run_id=r.id
         AND i.tool_name='ask_user' AND i.status='completed'
         AND NOT EXISTS(SELECT 1 FROM conversation_answer a WHERE a.question_invocation_id=i.id)
       UNION ALL
       SELECT r.id,'blocked',r.conversation_id,r.project_id,r.updated_at,NULL FROM run r
       JOIN conversation c ON c.id=r.conversation_id WHERE r.user_id=$1 AND c.status='active'
         AND c.current_run_id=r.id AND r.status IN ('failed','budget_exhausted')
       UNION ALL
       SELECT n.id,'deadline',t.conversation_id,t.project_id,n.updated_at,
         n.notice||jsonb_build_object('profile',COALESCE(n.notice->>'profile',t.profile),
           'jurisdictionTz',COALESCE(n.notice->>'jurisdictionTz',t.jurisdiction_tz)) FROM notification n
       JOIN timer t ON t.id=n.timer_id AND t.state='active'
       JOIN goal g ON g.id=t.goal_id AND g.owner_user_id=n.recipient_id AND g.status='active'
       WHERE n.recipient_id=$1 AND n.status='pending' AND (n.notice->>'dueAt')::timestamptz=t.due_at
         AND COALESCE(n.notice->>'profile',t.profile)=t.profile
         AND COALESCE(n.notice->>'jurisdictionTz',t.jurisdiction_tz)=t.jurisdiction_tz
       UNION ALL
       SELECT n.id,'verification',l.conversation_id,r.project_id,n.created_at,NULL FROM verification_notice n
       JOIN verification_link l ON l.room_id=n.room_id JOIN run r ON r.id=l.run_id
       WHERE n.recipient_user_id=$1 AND n.acknowledged_at IS NULL
       UNION ALL
       SELECT p.id,'outbound',p.conversation_id,p.project_id,q.updated_at,NULL
       FROM proposal p JOIN outbound_message q ON q.proposal_id=p.id AND q.status::text=p.status::text
       WHERE p.proposed_by=$1 AND p.status IN ('reconcile','failed') AND q.channel='local_test' AND q.attempts=1
         AND NOT EXISTS(SELECT 1 FROM outbound_resolution decided WHERE decided.queue_id=q.id)
       UNION ALL
       SELECT p.id,'skill',NULL::uuid,NULL::uuid,p.created_at,NULL
       FROM skill_rollback_proposal p JOIN skill s ON s.id=p.skill_id AND s.revision=p.release_revision
       WHERE p.status IN ('pending','notice')
       UNION ALL
       SELECT r.id,'knowledge_review',NULL::uuid,NULL::uuid,r.created_at,NULL
       FROM knowledge_review r WHERE r.status='pending'
     ) SELECT p.id,p.kind,p.conversation_id AS "conversationId",p.project_id AS "projectId",p.created_at AS "createdAt",p.deadline,
       CASE WHEN v.id IS NOT NULL THEN jsonb_build_object('roomId',v.room_id,'kind',v.kind) END AS verification,
       CASE WHEN rb.id IS NOT NULL THEN jsonb_build_object('skillId',rb.skill_id,'activeVersion',sv.version) END AS "skillRollback",
       CASE WHEN kr.id IS NOT NULL THEN jsonb_build_object('kind',kr.kind,'title',kr.content->>'title','version',kr.version) END AS "knowledgeReview"
       FROM (
         (SELECT * FROM pending WHERE kind<>'skill' ORDER BY created_at DESC,id DESC LIMIT $2)
         UNION ALL
         (SELECT * FROM pending WHERE kind='skill' ORDER BY created_at DESC,id DESC LIMIT $3)
       ) p LEFT JOIN verification_notice v ON v.id=p.id AND p.kind='verification'
       LEFT JOIN skill_rollback_proposal rb ON rb.id=p.id AND p.kind='skill'
       LEFT JOIN skill_version sv ON sv.id=rb.active_version_id
       LEFT JOIN knowledge_review kr ON kr.id=p.id AND p.kind='knowledge_review'
       ORDER BY (p.kind='skill'),p.created_at DESC,p.id DESC`,
      [actor.userId, noticeLimit + 1, skillLimit + 1],
    )
  ).rows;
  const notices = rows.filter(({ kind }) => kind !== 'skill');
  const skillItems = rows.filter(({ kind }) => kind === 'skill');
  const items = [...notices.slice(0, noticeLimit), ...skillItems.slice(0, skillLimit)];
  return memberNotificationSnapshotSchema.parse({
    generatedAt: new Date().toISOString(),
    items: items.map(
      ({ createdAt, deadline, verification, skillRollback, knowledgeReview, ...row }) => ({
        ...row,
        createdAt: createdAt.toISOString(),
        ...(deadline ? { deadline } : {}),
        ...(verification ? { verification } : {}),
        ...(skillRollback ? { skillRollback } : {}),
        ...(knowledgeReview ? { knowledgeReview } : {}),
      }),
    ),
    truncated: notices.length > noticeLimit || skillItems.length > skillLimit,
  });
}
