import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyRequest,
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
} from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  browserIdentitySchema,
  toolApprovalParamsSchema,
  toolApprovalDecisionInputSchema,
  toolApprovalDecisionResultSchema,
  toolApprovalViewSchema,
  toolApprovalDisplaySchema,
  type BackendConfig,
  type BrowserIdentity,
  type DataLevel,
} from '@cert-board/shared';
import { requireBrowserIdentity } from '../auth/session.js';
import { authorize } from '../auth/authorization.js';
import { AppError } from './errors.js';
import { approvalContentHash } from '../approvals/service.js';
import { scheduleToolContinuation } from '../approvals/continuation.js';

type ApprovalRow = {
  id: string;
  invocation_id: string;
  run_id: string;
  conversation_id: string;
  user_id: string;
  project_id: string;
  goal_id: string;
  tool_name: string;
  tool_version: string;
  arguments_hash: string;
  content_hash: string;
  direction_version: number;
  preview_json: unknown;
  target_versions_json: unknown;
  data_level: DataLevel;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  version: number;
  created_at: Date;
  decided_at: Date | null;
};
type DecisionRow = {
  id: string;
  approval_id: string;
  source_version: number;
  content_hash: string;
  action: 'allow_once' | 'allow_conversation' | 'reject';
  reason: string | null;
};

export function registerApprovalRoutes<Logger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    Logger
  >,
  pool: Pool,
  config: BackendConfig,
) {
  const missing = () =>
    new AppError(404, 'APPROVAL_NOT_FOUND', '没有找到本人对话中的批准请求，请从原对话重新打开。');
  const conflict = () =>
    new AppError(409, 'APPROVAL_VERSION_CONFLICT', '批准请求或上下文已经变化，请刷新后重新核对。');
  const identifier = (request: FastifyRequest) => {
    const parsed = toolApprovalParamsSchema.safeParse(request.params);
    if (!parsed.success)
      throw new AppError(400, 'APPROVAL_ID_INVALID', '批准请求编号无效，请重新打开。');
    return parsed.data.id;
  };
  // 不导出接收身份声明的决定函数，决定只从本闭包中的真实浏览器请求进入。
  const browserTransaction = async <T>(
    request: FastifyRequest,
    write: boolean,
    operation: (tx: PoolClient, actor: BrowserIdentity) => Promise<T>,
  ) => {
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      const first = await requireBrowserIdentity(request, tx, config, { write });
      const session = await tx.query<{ is_management: boolean }>(
        `SELECT u.is_management FROM web_session s JOIN app_user u ON u.id=s.user_id
         WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>CURRENT_TIMESTAMP
         AND u.status='active' FOR SHARE OF s,u`,
        [first.sessionId, first.userId],
      );
      if (!session.rows[0]) throw new AppError(401, 'LOGIN_REQUIRED', '登录已失效，请重新登录。');
      const checked = await requireBrowserIdentity(request, tx, config, { write });
      const actor = browserIdentitySchema.parse({
        ...checked,
        isManagement: session.rows[0].is_management,
      });
      const result = await operation(tx, actor);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError(
        500,
        'APPROVAL_TRANSACTION_FAILED',
        '批准请求处理未完成，本次决定未生效，请刷新后重试。',
      );
    } finally {
      tx.release();
    }
  };
  const locate = async (tx: PoolClient, actor: BrowserIdentity, id: string) => {
    const result = await tx.query<ApprovalRow>(
      `SELECT a.* FROM tool_approval a JOIN conversation c ON c.id=a.conversation_id AND c.user_id=a.user_id
       WHERE a.id=$1 AND c.user_id=$2`,
      [id, actor.userId],
    );
    const row = result.rows[0];
    if (
      !row ||
      !authorize(actor, 'approval.decide', { ownerUserId: row.user_id, projectId: row.project_id })
    )
      throw missing();
    return row;
  };
  const verifyHash = (row: ApprovalRow) => {
    const actual = approvalContentHash({
      invocationId: row.invocation_id,
      runId: row.run_id,
      conversationId: row.conversation_id,
      userId: row.user_id,
      projectId: row.project_id,
      goalId: row.goal_id,
      toolName: row.tool_name,
      toolVersion: row.tool_version,
      argumentsHash: row.arguments_hash,
      preview: row.preview_json,
      targetVersions: row.target_versions_json,
      directionVersion: row.direction_version,
      dataLevel: row.data_level,
    });
    if (actual !== row.content_hash) throw conflict();
  };
  const dto = (row: ApprovalRow) => {
    verifyHash(row);
    return toolApprovalViewSchema.parse({
      id: row.id,
      conversationId: row.conversation_id,
      runId: row.run_id,
      toolName: row.tool_name,
      toolVersion: row.tool_version,
      version: row.version,
      contentHash: row.content_hash,
      status: row.status,
      preview: toolApprovalDisplaySchema.parse(row.preview_json),
      dataLevel: row.data_level,
      createdAt: row.created_at.toISOString(),
      decidedAt: row.decided_at?.toISOString() ?? null,
    });
  };

  app.get('/api/approvals/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return browserTransaction(request, false, async (tx, actor) =>
      dto(await locate(tx, actor, identifier(request))),
    );
  });
  app.post('/api/approvals/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return browserTransaction(request, true, async (tx, actor) => {
      const parsed = toolApprovalDecisionInputSchema.safeParse(request.body);
      if (!parsed.success)
        throw new AppError(
          400,
          'APPROVAL_DECISION_INVALID',
          '请明确允许、仅本对话允许或拒绝，并刷新批准请求版本。',
        );
      const input = parsed.data;
      const id = identifier(request);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `tool-approval-decision:${actor.userId}:${input.requestKey}`,
      ]);
      const initial = await locate(tx, actor, id);
      const target = await tx.query<{
        project_id: string;
        status: string;
        direction_version: number;
      }>('SELECT project_id,status,direction_version FROM goal WHERE id=$1 FOR UPDATE', [
        initial.goal_id,
      ]);
      const conversations = await tx.query<{
        user_id: string;
        project_id: string;
        goal_id: string;
        permission_mode: string;
        status: string;
      }>(
        'SELECT user_id,project_id,goal_id,permission_mode,status FROM conversation WHERE id=$1 FOR UPDATE',
        [initial.conversation_id],
      );
      const runs = await tx.query<{
        user_id: string;
        conversation_id: string;
        project_id: string;
        goal_id: string;
        direction_version: number;
        status: string;
      }>(
        'SELECT user_id,conversation_id,project_id,goal_id,direction_version,status FROM run WHERE id=$1 FOR UPDATE',
        [initial.run_id],
      );
      const records = await tx.query<ApprovalRow>(
        'SELECT * FROM tool_approval WHERE id=$1 FOR UPDATE',
        [id],
      );
      const row = records.rows[0],
        conversation = conversations.rows[0],
        run = runs.rows[0],
        goal = target.rows[0];
      if (
        !row ||
        !conversation ||
        !run ||
        !goal ||
        row.user_id !== actor.userId ||
        conversation.user_id !== actor.userId ||
        run.user_id !== actor.userId ||
        row.conversation_id !== initial.conversation_id ||
        row.run_id !== initial.run_id ||
        row.project_id !== initial.project_id ||
        row.goal_id !== initial.goal_id ||
        conversation.project_id !== row.project_id ||
        conversation.goal_id !== row.goal_id ||
        run.conversation_id !== row.conversation_id ||
        run.project_id !== row.project_id ||
        run.goal_id !== row.goal_id ||
        goal.project_id !== row.project_id
      )
        throw missing();
      verifyHash(row);
      const previous = (
        await tx.query<DecisionRow>(
          'SELECT id,approval_id,source_version,content_hash,action,reason FROM tool_approval_decision WHERE actor_user_id=$1 AND request_key=$2',
          [actor.userId, input.requestKey],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.approval_id !== id ||
          previous.source_version !== input.expectedVersion ||
          previous.content_hash !== input.expectedContentHash ||
          previous.action !== input.action ||
          previous.reason !== (input.reason ?? null)
        )
          throw new AppError(
            409,
            'APPROVAL_REQUEST_CONFLICT',
            '同一请求编号不能改换批准请求、版本、决定或原因，请刷新后使用新编号。',
          );
        return toolApprovalDecisionResultSchema.parse({
          approvalId: id,
          decisionId: previous.id,
          status: previous.action === 'reject' ? 'rejected' : 'approved',
          version: row.version,
          replayed: true,
          executed: false,
          continuationId: await scheduleToolContinuation(tx, id, previous.id),
        });
      }
      if (
        row.status !== 'pending' ||
        row.version !== input.expectedVersion ||
        row.content_hash !== input.expectedContentHash
      )
        throw conflict();
      if (
        input.action !== 'reject' &&
        (conversation.status !== 'active' ||
          conversation.permission_mode === 'read_only' ||
          !['running', 'waiting'].includes(run.status) ||
          goal.status !== 'active' ||
          run.direction_version !== goal.direction_version ||
          row.direction_version !== goal.direction_version)
      )
        throw conflict();
      const decision = (
        await tx.query<{ id: string }>(
          `INSERT INTO tool_approval_decision(approval_id,actor_user_id,session_id,request_key,source_version,content_hash,action,reason)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [
            id,
            actor.userId,
            actor.sessionId,
            input.requestKey,
            row.version,
            row.content_hash,
            input.action,
            input.reason ?? null,
          ],
        )
      ).rows[0]!;
      const status = input.action === 'reject' ? 'rejected' : 'approved';
      await tx.query(
        `UPDATE tool_approval SET status=$2,version=version+1,decided_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
        [id, status],
      );
      if (input.action === 'allow_conversation') {
        await tx.query(
          `INSERT INTO conversation_tool_grant(conversation_id,user_id,tool_name,tool_version,source_decision_id)
           VALUES($1,$2,$3,$4,$5) ON CONFLICT(conversation_id,user_id,tool_name,tool_version) DO NOTHING`,
          [row.conversation_id, actor.userId, row.tool_name, row.tool_version, decision.id],
        );
      }
      await tx.query(
        `INSERT INTO audit_log(actor_user_id,actor_kind,action,target_type,target_id,after_hash)
        VALUES($1,'browser',$2,'tool_approval',$3,$4)`,
        [
          actor.userId,
          status === 'approved' ? 'tool.approval_allowed' : 'tool.approval_rejected',
          id,
          row.content_hash,
        ],
      );
      return toolApprovalDecisionResultSchema.parse({
        approvalId: id,
        decisionId: decision.id,
        status,
        version: row.version + 1,
        replayed: false,
        executed: false,
        continuationId: await scheduleToolContinuation(tx, id, decision.id),
      });
    });
  });
}
