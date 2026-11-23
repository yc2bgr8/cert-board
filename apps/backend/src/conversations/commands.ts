import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  conversationCreateInputSchema,
  defaultPermissionMode,
  conversationCreateResultSchema,
  conversationRecordSchema,
  conversationMessageInputSchema,
  conversationWriteResultSchema,
  conversationModeInputSchema,
  conversationModeResultSchema,
  conversationAnswerInputSchema,
  conversationStopInputSchema,
  conversationStopResultSchema,
  agentQuestionSchema,
  toolStoredPayloadSchema,
  type BrowserIdentity,
  type PermissionMode,
  type AgentCode,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { appendConversationEventTx, appendConversationMessageTx } from './storage.js';
import { stopOwnedRun } from '../runs/control.js';

type Conversation = {
  id: string;
  project_id: string | null;
  goal_id: string | null;
  user_id: string;
  title: string;
  permission_mode: PermissionMode;
  permission_version: number;
  agent_code: AgentCode;
  current_run_id: string | null;
  status: string;
  max_data_level: 'internal' | 'confidential';
  version: number;
  created_at: Date;
  updated_at: Date;
};
type CurrentRun = {
  id: string;
  status: string;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  direction_version: number;
};
const identifier = z.string().uuid();
const missing = () =>
  new AppError(
    404,
    'CONVERSATION_WRITE_FORBIDDEN',
    '没有找到本人可操作的对话，请从自己的对话重新打开。',
  );
const invalid = () =>
  new AppError(400, 'CONVERSATION_COMMAND_INVALID', '请求格式无效，请检查内容并从当前界面重试。');
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
const digest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
async function command(
  tx: PoolClient,
  actor: BrowserIdentity,
  requestKey: string,
  action: string,
  target: unknown,
  payload: unknown,
  payloadForDefaultMode?: (mode: PermissionMode) => unknown,
) {
  const hash = digest({ action, target, payload });
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `conversation-command:${actor.userId}:${requestKey}`,
  ]);
  const prior = (
    await tx.query<{
      action: string;
      payload_hash: string;
      result_json: Record<string, unknown>;
      create_default_mode: PermissionMode;
    }>(
      'SELECT action,payload_hash,result_json,create_default_mode FROM conversation_command WHERE user_id=$1 AND request_key=$2',
      [actor.userId, requestKey],
    )
  ).rows[0];
  const priorHash =
    prior && payloadForDefaultMode
      ? digest({ action, target, payload: payloadForDefaultMode(prior.create_default_mode) })
      : hash;
  if (prior && (prior.action !== action || prior.payload_hash !== priorHash))
    throw new AppError(
      409,
      'CONVERSATION_REQUEST_CONFLICT',
      '同一请求编号不能改换操作、对话或内容，请使用新的请求编号。',
    );
  return { hash, prior: prior ? { ...prior.result_json, replayed: true } : null };
}
async function saved(
  tx: PoolClient,
  actor: BrowserIdentity,
  conversationId: string,
  requestKey: string,
  action: string,
  hash: string,
  result: unknown,
  createDefaultMode: PermissionMode = 'ask',
) {
  await tx.query(
    `INSERT INTO conversation_command(user_id,session_id,conversation_id,request_key,action,payload_hash,result_json,create_default_mode)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      actor.userId,
      actor.sessionId,
      conversationId,
      requestKey,
      action,
      hash,
      JSON.stringify(result),
      createDefaultMode,
    ],
  );
}
function record(row: Conversation) {
  return conversationRecordSchema.parse({
    id: row.id,
    projectId: row.project_id,
    goalId: row.goal_id,
    userId: row.user_id,
    title: row.title,
    permissionMode: row.permission_mode,
    agentCode: row.agent_code,
    maxDataLevel: row.max_data_level,
    status: row.status,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}
async function located(tx: PoolClient, actor: BrowserIdentity, conversationId: string) {
  if (!identifier.safeParse(conversationId).success) throw invalid();
  const row = (
    await tx.query<Conversation>('SELECT * FROM conversation WHERE id=$1 AND user_id=$2', [
      conversationId,
      actor.userId,
    ])
  ).rows[0];
  if (!row) throw missing();
  return row;
}
async function lockConversation(tx: PoolClient, actor: BrowserIdentity, conversationId: string) {
  const initial = await located(tx, actor, conversationId);
  let workspace: { id: string; current_version_id: string | null; data_level: string } | undefined;
  if (initial.project_id)
    workspace = (
      await tx.query<{ id: string; current_version_id: string | null; data_level: string }>(
        'SELECT id,current_version_id,data_level FROM workspace WHERE project_id=$1 FOR SHARE',
        [initial.project_id],
      )
    ).rows[0];
  let goal:
    { id: string; project_id: string; status: string; direction_version: number } | undefined;
  if (initial.goal_id)
    goal = (
      await tx.query<{ id: string; project_id: string; status: string; direction_version: number }>(
        'SELECT id,project_id,status,direction_version FROM goal WHERE id=$1 FOR SHARE',
        [initial.goal_id],
      )
    ).rows[0];
  const conversation = (
    await tx.query<Conversation>(
      'SELECT * FROM conversation WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [conversationId, actor.userId],
    )
  ).rows[0];
  if (
    !conversation ||
    conversation.project_id !== initial.project_id ||
    conversation.goal_id !== initial.goal_id ||
    conversation.status !== 'active'
  )
    throw missing();
  let current: CurrentRun | undefined;
  if (conversation.current_run_id)
    current = (
      await tx.query<CurrentRun>(
        'SELECT id,status,lease_owner,lease_expires_at,direction_version FROM run WHERE id=$1 AND conversation_id=$2 AND user_id=$3 FOR UPDATE',
        [conversation.current_run_id, conversationId, actor.userId],
      )
    ).rows[0];
  else {
    const previous = (
      await tx.query<CurrentRun>(
        'SELECT id,status,lease_owner,lease_expires_at,direction_version FROM run WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT 2 FOR UPDATE',
        [conversationId, actor.userId],
      )
    ).rows;
    if (previous.length > 1)
      throw new AppError(
        409,
        'CONVERSATION_HEAD_UNAVAILABLE',
        '旧对话的当前运行尚未确定，请重新打开或新建对话。',
      );
    current = previous[0];
    if (current) {
      await tx.query('UPDATE conversation SET current_run_id=$2 WHERE id=$1', [
        conversationId,
        current.id,
      ]);
      conversation.current_run_id = current.id;
    }
  }
  if (conversation.current_run_id && !current) throw missing();
  return { conversation, current, workspace, goal };
}
function runnable(context: Awaited<ReturnType<typeof lockConversation>>) {
  const { conversation, goal, workspace } = context;
  if (
    !conversation.project_id ||
    !conversation.goal_id ||
    !goal ||
    goal.project_id !== conversation.project_id ||
    !workspace?.current_version_id
  )
    throw new AppError(
      409,
      'CONVERSATION_PROJECT_REQUIRED',
      '请先进入有真实目标和工作区的项目，再发送任务；当前对话只保存了基本信息。',
    );
  if (goal.status !== 'active')
    throw new AppError(409, 'CONVERSATION_GOAL_INACTIVE', '当前目标不能运行，请先核对目标状态。');
  return {
    projectId: conversation.project_id,
    goalId: goal.id,
    directionVersion: goal.direction_version,
  };
}
async function activeLease(tx: PoolClient, run: CurrentRun) {
  const now = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
  return Boolean(run.lease_owner && run.lease_expires_at && run.lease_expires_at > now);
}
async function waiting(tx: PoolClient, runId: string) {
  const approval = (
    await tx.query<{ id: string }>(
      `SELECT a.id FROM tool_approval a
    WHERE a.run_id=$1 AND (a.status='pending' OR EXISTS(SELECT 1 FROM run_continuation t WHERE t.approval_id=a.id AND t.state IN ('pending','queued','claimed'))) LIMIT 1`,
      [runId],
    )
  ).rows[0];
  if (approval) return { kind: 'approval' as const, id: approval.id };
  const question = (
    await tx.query<{ id: string; call_id: string; content_json: unknown }>(
      `SELECT i.id,i.call_id,p.content_json FROM tool_invocation i JOIN conversation_tool_result p ON p.invocation_id=i.id
     WHERE i.run_id=$1 AND i.tool_name='ask_user' AND i.operation='execute' AND i.status='completed'
     AND NOT EXISTS(SELECT 1 FROM conversation_answer a WHERE a.question_invocation_id=i.id)
     ORDER BY i.created_at DESC,i.id DESC LIMIT 1`,
      [runId],
    )
  ).rows[0];
  if (question)
    return {
      kind: 'question' as const,
      id: question.call_id,
      invocationId: question.id,
      content: question.content_json,
    };
  const review = (
    await tx.query<{ id: string }>(
      "SELECT id FROM review_card WHERE run_id=$1 AND status='pending' ORDER BY created_at DESC,id DESC LIMIT 1",
      [runId],
    )
  ).rows[0];
  if (review) return { kind: 'review' as const, id: review.id };
  const proposal = (
    await tx.query<{ id: string }>(
      "SELECT id FROM proposal WHERE run_id=$1 AND status IN ('proposed','approved') ORDER BY created_at DESC,id DESC LIMIT 1",
      [runId],
    )
  ).rows[0];
  return proposal ? { kind: 'proposal' as const, id: proposal.id } : null;
}
async function newRun(
  tx: PoolClient,
  actor: BrowserIdentity,
  context: Awaited<ReturnType<typeof lockConversation>>,
  requestKey: string,
  text: string,
) {
  const scope = runnable(context);
  const runId = randomUUID();
  await tx.query(
    `INSERT INTO run(id,conversation_id,user_id,project_id,goal_id,direction_version,status,max_data_level,trigger_type)
    VALUES($1,$2,$3,$4,$5,$6,'queued',$7,'conversation')`,
    [
      runId,
      context.conversation.id,
      actor.userId,
      scope.projectId,
      scope.goalId,
      scope.directionVersion,
      context.conversation.max_data_level,
    ],
  );
  const message = await appendConversationMessageTx(tx, {
    runId,
    userId: actor.userId,
    requestKey,
    message: { role: 'user', content: text },
  });
  await appendConversationEventTx(tx, {
    runId,
    userId: actor.userId,
    requestKey,
    event: { type: 'user_message', payload: { runId, messageId: message.id, text } },
  });
  return { runId, messageId: message.id };
}

export async function createConversationTx(
  tx: PoolClient,
  actor: BrowserIdentity,
  input: unknown,
  projectId?: string,
) {
  const parsed = conversationCreateInputSchema.safeParse(input);
  if (!parsed.success || (projectId !== undefined && !identifier.safeParse(projectId).success))
    throw invalid();
  const data = parsed.data;
  // 省略权限的重试按原回执的默认模式解析，显式权限请求保留原签名格式。
  const payloadForDefaultMode = Object.hasOwn(input as object, 'permissionMode')
    ? undefined
    : (permissionMode: PermissionMode) => ({ ...data, permissionMode });
  const intent = await command(
    tx,
    actor,
    data.requestKey,
    'create',
    projectId ?? null,
    data,
    payloadForDefaultMode,
  );
  if (intent.prior) return conversationCreateResultSchema.parse(intent.prior);
  let agentCode = data.agentCode ?? 'registration';
  let goalId: string | null = null;
  if (projectId) {
    const project = (
      await tx.query<{ project_type: AgentCode }>(
        'SELECT project_type FROM cert_project WHERE id=$1 FOR SHARE',
        [projectId],
      )
    ).rows[0];
    if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', '没有找到该项目，请重新选择。');
    if (data.agentCode && data.agentCode !== project.project_type)
      throw new AppError(400, 'CONVERSATION_AGENT_MISMATCH', '项目对话必须使用该项目对应的Agent。');
    agentCode = project.project_type;
    if (data.goalId) {
      const goal = await tx.query('SELECT id FROM goal WHERE id=$1 AND project_id=$2', [
        data.goalId,
        projectId,
      ]);
      if (!goal.rowCount)
        throw new AppError(400, 'CONVERSATION_GOAL_MISMATCH', '目标不属于所选项目，请重新选择。');
      goalId = data.goalId;
    } else {
      const goals = (
        await tx.query<{ id: string }>(
          "SELECT id FROM goal WHERE project_id=$1 AND status='active' ORDER BY created_at,id LIMIT 2",
          [projectId],
        )
      ).rows;
      if (goals.length > 1)
        throw new AppError(
          400,
          'CONVERSATION_GOAL_REQUIRED',
          '该项目有多个活动目标，请明确选择一个。',
        );
      goalId = goals[0]?.id ?? null;
    }
  } else if (data.goalId)
    throw new AppError(400, 'CONVERSATION_PROJECT_REQUIRED', '项目外对话不能指定其他项目的目标。');
  const row = (
    await tx.query<Conversation>(
      'INSERT INTO conversation(project_id,goal_id,user_id,title,agent_code,permission_mode) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [
        projectId ?? null,
        goalId,
        actor.userId,
        data.title ?? '新对话',
        agentCode,
        data.permissionMode,
      ],
    )
  ).rows[0]!;
  const result = conversationCreateResultSchema.parse({
    conversation: record(row),
    permissionVersion: row.permission_version,
    replayed: false,
  });
  await saved(
    tx,
    actor,
    row.id,
    data.requestKey,
    'create',
    intent.hash,
    result,
    defaultPermissionMode,
  );
  return result;
}

export async function sendConversationMessageTx(
  tx: PoolClient,
  actor: BrowserIdentity,
  conversationId: string,
  input: unknown,
) {
  const parsed = conversationMessageInputSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  const data = parsed.data,
    intent = await command(tx, actor, data.requestKey, 'message', conversationId, data);
  if (intent.prior) return conversationWriteResultSchema.parse(intent.prior);
  const context = await lockConversation(tx, actor, conversationId);
  const current = context.current;
  const awaitingVerification =
    current &&
    (
      await tx.query(
        `SELECT 1 FROM verification_wait WHERE run_id=$1 AND conversation_id=$2 AND user_id=$3 AND state IN ('waiting','queued')
     UNION ALL SELECT 1 FROM verification_link l
     WHERE l.run_id=$1 AND l.conversation_id=$2 AND l.kind='review' AND l.auto_resume
      AND NOT EXISTS(SELECT 1 FROM goal_event e WHERE e.source='verification' AND e.source_key=l.room_id::text)`,
        [current.id, conversationId, actor.userId],
      )
    ).rowCount;
  if (!awaitingVerification) runnable(context);
  if (
    current &&
    (awaitingVerification || ['queued', 'running', 'waiting'].includes(current.status))
  ) {
    if (!awaitingVerification && current.direction_version !== context.goal?.direction_version)
      throw new AppError(
        409,
        'CONVERSATION_DIRECTION_CHANGED',
        '当前运行的目标方向已改变，请停止旧运行后重新发送。',
      );
    const pending = await waiting(tx, current.id);
    if (pending?.kind === 'approval' || pending?.kind === 'proposal')
      throw new AppError(
        409,
        'CONVERSATION_APPROVAL_PENDING',
        '请先在浏览器处理当前批准请求或外发提案；普通消息不能代替决定。',
      );
    if (pending?.kind === 'question')
      throw new AppError(
        409,
        'CONVERSATION_ANSWER_REQUIRED',
        '当前正在等待回答，请使用提问卡提交回答。',
      );
    if (
      !awaitingVerification &&
      pending?.kind === 'review' &&
      (current.status !== 'waiting' || (await activeLease(tx, current)))
    )
      throw new AppError(
        409,
        'CONVERSATION_RUN_FINISHING',
        '上一轮正在保存结束状态，请稍后重试这条修改意见。',
      );
    if (!awaitingVerification && current.status === 'waiting' && pending?.kind !== 'review')
      throw new AppError(409, 'CONVERSATION_WAITING', '当前轮仍在等待处理，请先核对待处理事项。');
    if (awaitingVerification || current.status !== 'waiting') {
      if (current.status === 'running' && !(await activeLease(tx, current)))
        throw new AppError(
          409,
          'CONVERSATION_RUN_RECOVERING',
          '后台执行权已失效，正在保留中途结果；请稍后重试，原文尚未发送。',
        );
      const steeringId = randomUUID();
      await tx.query(
        'INSERT INTO run_steering_message(id,run_id,conversation_id,user_id,request_key,content) VALUES($1,$2,$3,$4,$5,$6)',
        [steeringId, current.id, conversationId, actor.userId, data.requestKey, data.text],
      );
      await appendConversationEventTx(tx, {
        runId: current.id,
        userId: actor.userId,
        requestKey: data.requestKey,
        event: {
          type: 'user_message',
          payload: { runId: current.id, steeringId, text: data.text },
        },
      });
      const result = conversationWriteResultSchema.parse({
        conversationId,
        runId: current.id,
        messageId: null,
        steeringId,
        answerId: null,
        kind: 'steering',
        replayed: false,
      });
      await saved(tx, actor, conversationId, data.requestKey, 'message', intent.hash, result);
      return result;
    }
    // 待审核的报告已交付。新一轮处理修改意见，原审核卡仍保留给人查看和决定。
    await tx.query(
      `UPDATE run SET status='completed',lease_owner=NULL,lease_expires_at=NULL,
       finished_at=COALESCE(finished_at,CURRENT_TIMESTAMP),version=version+1,updated_at=CURRENT_TIMESTAMP
       WHERE id=$1`,
      [current.id],
    );
    await appendConversationEventTx(tx, {
      runId: current.id,
      userId: actor.userId,
      requestKey: data.requestKey,
      event: {
        type: 'run_status',
        payload: {
          status: 'completed',
          reasonCode: 'REVIEW_REVISION_STARTED',
          message: '已收到修改意见，接下来在同一对话中处理。原审核卡仍可查看。',
        },
      },
    });
  }
  const created = await newRun(tx, actor, context, data.requestKey, data.text);
  await tx.query(
    'UPDATE conversation SET current_run_id=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1',
    [conversationId, created.runId],
  );
  const result = conversationWriteResultSchema.parse({
    conversationId,
    ...created,
    steeringId: null,
    answerId: null,
    kind: 'queued',
    replayed: false,
  });
  await saved(tx, actor, conversationId, data.requestKey, 'message', intent.hash, result);
  return result;
}

export async function changeConversationModeTx(
  tx: PoolClient,
  actor: BrowserIdentity,
  conversationId: string,
  input: unknown,
) {
  const parsed = conversationModeInputSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  const data = parsed.data,
    intent = await command(tx, actor, data.requestKey, 'mode', conversationId, data);
  if (intent.prior) return conversationModeResultSchema.parse(intent.prior);
  const context = await lockConversation(tx, actor, conversationId);
  if (context.conversation.permission_version !== data.expectedVersion)
    throw new AppError(
      409,
      'CONVERSATION_MODE_VERSION_CONFLICT',
      '权限模式已在其他请求中改变，请刷新后再选择。',
    );
  let version = context.conversation.permission_version;
  if (context.conversation.permission_mode !== data.permissionMode) {
    version = (
      await tx.query<{ permission_version: number }>(
        'UPDATE conversation SET permission_mode=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING permission_version',
        [conversationId, data.permissionMode],
      )
    ).rows[0]!.permission_version;
    if (context.current)
      await appendConversationEventTx(tx, {
        runId: context.current.id,
        userId: actor.userId,
        requestKey: data.requestKey,
        event: {
          type: 'permission_changed',
          payload: { permissionMode: data.permissionMode, permissionVersion: version },
        },
      });
    await tx.query(
      "INSERT INTO audit_log(actor_user_id,actor_kind,action,target_type,target_id,before_hash,after_hash) VALUES($1,'browser','conversation.permission_changed','conversation',$2,$3,$4)",
      [
        actor.userId,
        conversationId,
        digest(context.conversation.permission_mode),
        digest(data.permissionMode),
      ],
    );
  }
  const result = conversationModeResultSchema.parse({
    conversationId,
    permissionMode: data.permissionMode,
    version,
    replayed: false,
  });
  await saved(tx, actor, conversationId, data.requestKey, 'mode', intent.hash, result);
  return result;
}

export async function answerQuestionTx(
  tx: PoolClient,
  actor: BrowserIdentity,
  conversationId: string,
  input: unknown,
) {
  const parsed = conversationAnswerInputSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  const data = parsed.data,
    intent = await command(tx, actor, data.requestKey, 'answer', conversationId, data);
  if (intent.prior) return conversationWriteResultSchema.parse(intent.prior);
  const context = await lockConversation(tx, actor, conversationId);
  runnable(context);
  if (
    !context.current ||
    context.current.id !== data.runId ||
    context.current.status !== 'waiting' ||
    context.current.direction_version !== context.goal?.direction_version ||
    (await activeLease(tx, context.current))
  )
    throw new AppError(
      409,
      'QUESTION_NOT_WAITING',
      '该问题已不是当前等待事项，或上一轮尚未结束，请刷新提问卡。',
    );
  const question = await waiting(tx, data.runId);
  if (question?.kind !== 'question' || question.id !== data.questionId)
    throw new AppError(409, 'QUESTION_NOT_WAITING', '问题编号与当前提问不一致，请刷新后回答。');
  const stored = toolStoredPayloadSchema.parse(question.content);
  if (stored.status !== 'completed')
    throw new AppError(409, 'QUESTION_NOT_WAITING', '原提问尚未保存完整，请稍后重试。');
  agentQuestionSchema.parse(stored.result.data);
  const created = await newRun(tx, actor, context, data.requestKey, data.text);
  const answerId = (
    await tx.query<{ id: string }>(
      `INSERT INTO conversation_answer(conversation_id,user_id,question_invocation_id,source_run_id,question_call_id,new_run_id,request_key,text)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        conversationId,
        actor.userId,
        question.invocationId,
        data.runId,
        data.questionId,
        created.runId,
        data.requestKey,
        data.text,
      ],
    )
  ).rows[0]!.id;
  await tx.query(
    "UPDATE run SET status='completed',finished_at=COALESCE(finished_at,clock_timestamp()),lease_owner=NULL,lease_expires_at=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=$1",
    [data.runId],
  );
  await tx.query(
    'UPDATE conversation SET current_run_id=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1',
    [conversationId, created.runId],
  );
  await appendConversationEventTx(tx, {
    runId: data.runId,
    userId: actor.userId,
    requestKey: data.requestKey,
    event: {
      type: 'question_answered',
      payload: { questionId: data.questionId, newRunId: created.runId, answerId },
    },
  });
  const result = conversationWriteResultSchema.parse({
    conversationId,
    ...created,
    steeringId: null,
    answerId,
    kind: 'answer',
    replayed: false,
  });
  await saved(tx, actor, conversationId, data.requestKey, 'answer', intent.hash, result);
  return result;
}

export async function preflightConversationStopTx(
  tx: PoolClient,
  actor: BrowserIdentity,
  conversationId: string,
  input: unknown,
) {
  const parsed = conversationStopInputSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  const data = parsed.data;
  const intent = await command(tx, actor, data.requestKey, 'stop', conversationId, data);
  if (intent.prior) return conversationStopResultSchema.parse(intent.prior);
  // 只读身份和范围，不拿会话/运行写锁；命令锁保留到外层事务提交。
  const conversation = await located(tx, actor, conversationId);
  if (
    conversation.status !== 'active' ||
    !(
      await tx.query('SELECT id FROM run WHERE id=$1 AND conversation_id=$2 AND user_id=$3', [
        data.runId,
        conversationId,
        actor.userId,
      ])
    ).rowCount
  )
    throw missing();
  return null;
}

export async function stopConversationRunTx(
  tx: PoolClient,
  actor: BrowserIdentity,
  conversationId: string,
  input: unknown,
) {
  const parsed = conversationStopInputSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  const data = parsed.data,
    intent = await command(tx, actor, data.requestKey, 'stop', conversationId, data);
  if (intent.prior) return conversationStopResultSchema.parse(intent.prior);
  await lockConversation(tx, actor, conversationId);
  if (
    !(
      await tx.query('SELECT id FROM run WHERE id=$1 AND conversation_id=$2 AND user_id=$3', [
        data.runId,
        conversationId,
        actor.userId,
      ])
    ).rowCount
  )
    throw missing();
  const stopped = await stopOwnedRun(tx, actor, data.runId);
  if (stopped.changed)
    await appendConversationEventTx(tx, {
      runId: data.runId,
      userId: actor.userId,
      requestKey: data.requestKey,
      event: {
        type: 'run_status',
        payload: {
          status: 'stopped',
          reasonCode: 'USER_STOPPED',
          message: '运行已停止，尚未投递的插话仍保留；未自动重放操作。',
        },
      },
    });
  const result = conversationStopResultSchema.parse({
    conversationId,
    runId: data.runId,
    stopped: stopped.status === 'stopped',
    replayed: false,
  });
  await saved(tx, actor, conversationId, data.requestKey, 'stop', intent.hash, result);
  return result;
}
