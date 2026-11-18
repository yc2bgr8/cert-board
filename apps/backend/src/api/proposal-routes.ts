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
  proposalParamsSchema,
  proposalDecisionSchema,
  proposalDecisionResultSchema,
  goalOutboundControlSchema,
  goalOutboundControlResultSchema,
  type BackendConfig,
  type BrowserIdentity,
} from '@cert-board/shared';
import { requireBrowserIdentity } from '../auth/session.js';
import { authorize } from '../auth/authorization.js';
import { AppError } from './errors.js';
import { proposalContentHash } from '../outbound/content.js';
import {
  proposalColumns,
  proposalDto,
  recipientMatches,
  type ProposalRow,
  type GoalRow,
  type ContactRow,
} from '../outbound/state.js';

export function registerProposalRoutes<Logger extends FastifyBaseLogger>(
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
    new AppError(404, 'PROPOSAL_NOT_FOUND', '没有找到可访问的提案，请从当前项目重新打开。');
  const identifier = (request: FastifyRequest) => {
    const result = proposalParamsSchema.safeParse(request.params);
    if (!result.success)
      throw new AppError(400, 'PROPOSAL_ID_INVALID', '提案或目标编号无效，请重新打开审核卡。');
    return result.data.id;
  };
  // 审批逻辑只封装在路由闭包，入口始终接收并验证浏览器请求，不接收外部传入的身份声明。
  const browserTransaction = async <T>(
    request: FastifyRequest,
    write: boolean,
    operation: (tx: PoolClient, identity: BrowserIdentity) => Promise<T>,
  ) => {
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      const authenticated = await requireBrowserIdentity(request, tx, config, { write });
      const locked = await tx.query(
        `SELECT s.id FROM web_session s JOIN app_user u ON u.id=s.user_id
        WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>CURRENT_TIMESTAMP AND u.status='active' FOR SHARE OF s,u`,
        [authenticated.sessionId, authenticated.userId],
      );
      if (!locked.rowCount) throw new AppError(401, 'LOGIN_REQUIRED', '登录已失效，请重新登录。');
      const checked = await requireBrowserIdentity(request, tx, config, { write });
      const identity = browserIdentitySchema.parse(checked);
      const result = await operation(tx, identity);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError(
        500,
        'PROPOSAL_TRANSACTION_FAILED',
        '提案处理失败，本次修改未生效，请刷新后重试。',
      );
    } finally {
      tx.release();
    }
  };
  const authorizeReview = async (
    tx: PoolClient,
    identity: BrowserIdentity,
    proposal: ProposalRow,
  ) => {
    const project = await tx.query<{ owner_user_id: string }>(
      'SELECT owner_user_id FROM cert_project WHERE id=$1',
      [proposal.projectId],
    );
    if (
      !project.rows[0] ||
      !authorize(identity, 'review.decide', {
        projectId: proposal.projectId,
        ownerUserId: project.rows[0].owner_user_id,
        reviewKind: 'registration',
      })
    )
      throw missing();
  };
  const locate = async (tx: PoolClient, proposalId: string) => {
    const result = await tx.query<{ goal_id: string }>('SELECT goal_id FROM proposal WHERE id=$1', [
      proposalId,
    ]);
    if (!result.rows[0]) throw missing();
    return result.rows[0].goal_id;
  };
  const goal = async (tx: PoolClient, goalId: string) => {
    const result = await tx.query<GoalRow>(
      'SELECT id,project_id,owner_user_id,status,outbound_paused,version FROM goal WHERE id=$1 FOR UPDATE',
      [goalId],
    );
    if (!result.rows[0]) throw missing();
    return result.rows[0];
  };

  app.get('/api/proposals/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return browserTransaction(request, false, async (tx, identity) => {
      const result = await tx.query<ProposalRow>(
        `SELECT ${proposalColumns} FROM proposal p WHERE p.id=$1`,
        [identifier(request)],
      );
      if (!result.rows[0]) throw missing();
      await authorizeReview(tx, identity, result.rows[0]);
      return proposalDto(result.rows[0]);
    });
  });
  app.post('/api/proposals/:id/decision', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return browserTransaction(request, true, async (tx, identity) => {
      const proposalId = identifier(request),
        parsed = proposalDecisionSchema.safeParse(request.body);
      if (!parsed.success)
        throw new AppError(
          400,
          'PROPOSAL_DECISION_INVALID',
          '审批参数无效，请刷新审核卡并明确通过或拒绝。',
        );
      const input = parsed.data;
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `proposal-decision:${identity.userId}:${input.requestKey}`,
      ]);
      const targetGoal = await goal(tx, await locate(tx, proposalId));
      const found = await tx.query<ProposalRow>(
        `SELECT ${proposalColumns} FROM proposal p WHERE p.id=$1 FOR UPDATE`,
        [proposalId],
      );
      const proposal = found.rows[0];
      if (
        !proposal ||
        proposal.goalId !== targetGoal.id ||
        proposal.projectId !== targetGoal.project_id
      )
        throw missing();
      await authorizeReview(tx, identity, proposal);
      const prior = await tx.query<{
        id: string;
        proposal_id: string;
        source_version: number;
        action: string;
        content_hash: string;
      }>(
        'SELECT id,proposal_id,source_version,action,content_hash FROM decision WHERE actor_user_id=$1 AND request_key=$2',
        [identity.userId, input.requestKey],
      );
      if (prior.rows[0]) {
        const previous = prior.rows[0];
        if (
          previous.proposal_id !== proposalId ||
          previous.source_version !== input.expectedVersion ||
          previous.action !== input.action ||
          previous.content_hash !== proposal.contentHash
        )
          throw new AppError(
            409,
            'PROPOSAL_REQUEST_CONFLICT',
            '同一审批请求编号对应的提案、版本或决定发生变化，请刷新后使用新的请求编号。',
          );
        const queue = await tx.query<{ id: string }>(
          'SELECT id FROM outbound_message WHERE decision_id=$1',
          [previous.id],
        );
        return proposalDecisionResultSchema.parse({
          proposalId,
          status: proposal.status,
          version: proposal.version,
          decisionId: previous.id,
          queueId: queue.rows[0]?.id ?? null,
          replayed: true,
        });
      }
      if (proposal.status !== 'proposed' || proposal.version !== input.expectedVersion)
        throw new AppError(
          409,
          'PROPOSAL_VERSION_CONFLICT',
          '提案状态或版本已经改变，请刷新审核卡后再决定。',
        );
      if (targetGoal.status !== 'active')
        throw new AppError(
          409,
          'PROPOSAL_GOAL_INACTIVE',
          '目标当前不能审批外发，请负责人恢复活动状态并重新核对。',
        );
      if (proposal.dataLevel !== 'internal' || proposal.channel !== 'local_test')
        throw new AppError(
          403,
          'PROPOSAL_CHANNEL_RESTRICTED',
          '当前开发流程仅支持内部级别的本地测试提案。',
        );
      if (proposalContentHash(proposal) !== proposal.contentHash)
        throw new AppError(
          409,
          'PROPOSAL_CONTENT_MISMATCH',
          '提案内容校验失败，请重新建立提案，不要批准旧卡片。',
        );
      const contacts = await tx.query<ContactRow>(
        'SELECT id,project_id,name,address,version,active,channel FROM contact WHERE id=$1 FOR SHARE',
        [proposal.contactId],
      );
      if (input.action === 'approved' && !recipientMatches(proposal, contacts.rows[0]))
        throw new AppError(
          409,
          'PROPOSAL_RECIPIENT_CHANGED',
          '联系人登记已改变或失效，请核对收件人后重新建立提案。',
        );
      const decision = await tx.query<{ id: string }>(
        `INSERT INTO decision(proposal_id,actor_user_id,session_id,request_key,source_version,action,content_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          proposalId,
          identity.userId,
          identity.sessionId,
          input.requestKey,
          proposal.version,
          input.action,
          proposal.contentHash,
        ],
      );
      const decisionId = decision.rows[0]!.id;
      const updated = await tx.query<{ version: number; status: string }>(
        'UPDATE proposal SET status=$1,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$2 RETURNING version,status',
        [input.action, proposalId],
      );
      const current = updated.rows[0]!;
      let queueId: string | null = null;
      if (input.action === 'approved') {
        const queue = await tx.query<{ id: string }>(
          `INSERT INTO outbound_message(proposal_id,decision_id,goal_id,project_id,contact_id,approved_version,channel)
          VALUES($1,$2,$3,$4,$5,$6,'local_test') RETURNING id`,
          [
            proposalId,
            decisionId,
            proposal.goalId,
            proposal.projectId,
            proposal.contactId,
            current.version,
          ],
        );
        queueId = queue.rows[0]!.id;
      }
      await tx.query(
        "INSERT INTO audit_log(actor_user_id,actor_kind,action,target_type,target_id,before_hash,after_hash) VALUES($1,'browser',$2,'proposal',$3,$4,$4)",
        [identity.userId, `proposal.${input.action}`, proposalId, proposal.contentHash],
      );
      return proposalDecisionResultSchema.parse({
        proposalId,
        status: current.status,
        version: current.version,
        decisionId,
        queueId,
        replayed: false,
      });
    });
  });
  app.post('/api/goals/:id/outbound-control', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return browserTransaction(request, true, async (tx, identity) => {
      const goalId = identifier(request),
        parsed = goalOutboundControlSchema.safeParse(request.body);
      if (!parsed.success)
        throw new AppError(
          400,
          'OUTBOUND_CONTROL_INVALID',
          '外发控制参数无效，请刷新目标状态后重试。',
        );
      const target = await goal(tx, goalId),
        input = parsed.data;
      if (
        !authorize(identity, 'record.write', {
          projectId: target.project_id,
          ownerUserId: target.owner_user_id,
        })
      )
        throw new AppError(
          403,
          'OUTBOUND_CONTROL_FORBIDDEN',
          '当前成员不能处理此事项的外发，请刷新身份后重试。',
        );
      if (target.outbound_paused === input.paused)
        return goalOutboundControlResultSchema.parse({
          goalId,
          paused: target.outbound_paused,
          version: target.version,
          resetProposalIds: [],
          truncated: false,
        });
      if (target.version !== input.expectedVersion)
        throw new AppError(
          409,
          'GOAL_VERSION_CONFLICT',
          '目标已经改变，请刷新后重新确认外发控制。',
        );
      if (!input.paused && target.status !== 'active')
        throw new AppError(409, 'OUTBOUND_GOAL_INACTIVE', '目标当前不是活动状态，不能恢复外发。');
      let resetIds: string[] = [];
      if (!input.paused) {
        await tx.query(
          "UPDATE internal_outbound_message SET status='cancelled',last_reason='外发恢复后旧内部消息不自动发送，请重新确认当前内容后发起。',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE goal_id=$1 AND status='queued' AND attempts=0",
          [goalId],
        );
        const proposals = await tx.query<{ id: string }>(
          "SELECT p.id FROM proposal p WHERE p.goal_id=$1 AND p.status='approved' AND EXISTS(SELECT 1 FROM outbound_message q WHERE q.proposal_id=p.id AND q.status='queued' AND q.attempts=0) ORDER BY p.id FOR UPDATE",
          [goalId],
        );
        resetIds = proposals.rows.map((row) => row.id);
        if (resetIds.length) {
          await tx.query(
            "UPDATE outbound_message SET status='cancelled',last_reason='外发恢复后必须重新批准，旧队列已取消。',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE goal_id=$1 AND proposal_id=ANY($2::uuid[]) AND status='queued' AND attempts=0",
            [goalId, resetIds],
          );
          await tx.query(
            "UPDATE proposal SET status='proposed',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=ANY($1::uuid[])",
            [resetIds],
          );
        }
      }
      const updated = await tx.query<{ version: number }>(
        'UPDATE goal SET outbound_paused=$1,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$2 RETURNING version',
        [input.paused, goalId],
      );
      await tx.query(
        "INSERT INTO audit_log(actor_user_id,actor_kind,action,target_type,target_id) VALUES($1,'browser',$2,'goal',$3)",
        [identity.userId, input.paused ? 'outbound.paused' : 'outbound.resumed', goalId],
      );
      return goalOutboundControlResultSchema.parse({
        goalId,
        paused: input.paused,
        version: updated.rows[0]!.version,
        resetProposalIds: resetIds.slice(0, 100),
        truncated: resetIds.length > 100,
      });
    });
  });
}
