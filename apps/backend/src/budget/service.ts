import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  budgetReserveSchema,
  budgetSettleSchema,
  budgetReconcileSchema,
  budgetIncompleteSchema,
  budgetPricesSchema,
  budgetReservationSchema,
  cumulativeUsageSchema,
  developmentBudgetEnvironmentSchema,
  agentIdentitySchema,
  type BudgetPrices,
  type BudgetReservation,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { authorize } from '../auth/authorization.js';
import { enforceCostLimits } from './cost-policy.js';
import { cancelGoalWaitTx, finishGoalWakeTx } from '../goals/goal-events.js';
import {
  cancelVerificationWaitsTx,
  stopReviewVerificationTx,
} from '../goals/verification-wakeups.js';
import { stopRunVerifications } from '../runs/control.js';
import {
  usdToNano,
  estimateCostNano,
  pickBeijingMonth,
  evaluateCumulativeBudget,
} from './meter.js';

type Policy = {
  id: string;
  environment: string;
  night_key: string;
  run_limit_nano: string;
  month_limit_nano: string;
  night_limit_nano: string;
  max_steps: string;
  max_tokens: string;
  alert_percent: number;
  blocked_reason: string | null;
  version: number;
};
type Identity = { requestKey: string; runId: string; userId: string };
type RunContext = {
  id: string;
  conversation_id: string;
  user_id: string;
  project_id: string | null;
  goal_id: string | null;
  direction_version: number;
  status: string;
  budget_steps: string;
  budget_total_tokens: string;
  budget_cost_nano: string | null;
  goalBudgetNano: bigint;
};
type Ledger = {
  id: string;
  request_key: string;
  run_id: string;
  conversation_id: string;
  user_id: string;
  goal_id: string | null;
  project_id: string | null;
  model_id: string;
  purpose: string;
  month_key: string;
  night_key: string;
  status: 'reserved' | 'settled' | 'unknown' | 'not_sent';
  reserved_nano: string;
  actual_nano: string | null;
  request_fingerprint: string;
  settlement_fingerprint: string | null;
  price_snapshot: BudgetPrices;
  estimated_input_tokens: string;
  max_output_tokens: string;
};
class Rejection {
  constructor(readonly error: AppError) {}
}
const fail = (status: number, code: string, message: string) => new AppError(status, code, message);
const invalid = () =>
  fail(
    400,
    'BUDGET_INPUT_INVALID',
    '计量参数无效，请提供当前运行身份、完整用量与精确价格，不要把缺失费用当作零。',
  );
const referenceSchema = budgetIncompleteSchema
  .pick({ requestKey: true, runId: true, userId: true })
  .strip();
const contextSchema = referenceSchema.omit({ requestKey: true });
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const fingerprint = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
async function transaction<T>(
  pool: Pool,
  operation: (tx: PoolClient) => Promise<T | Rejection>,
  handoffAfterCommit = true,
): Promise<T> {
  const tx = await pool.connect();
  let result: T | Rejection;
  try {
    await tx.query('BEGIN');
    result = await operation(tx);
    await tx.query('COMMIT');
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw fail(
      500,
      'BUDGET_TRANSACTION_FAILED',
      '预算登记未完成，不能发出模型请求，请核对计量状态后重试。',
    );
  } finally {
    tx.release();
  }
  // 费用已经提交并释放所有锁；后置交回失败绝不能变成结算失败或模型重发的依据。
  if (handoffAfterCommit) await handoffBlockedBudgetRuns(pool);
  if (result instanceof Rejection) throw result.error;
  return result;
}
async function policy(tx: PoolClient) {
  const found = await tx.query<Policy>("SELECT * FROM budget_policy WHERE id='default' FOR UPDATE");
  if (!found.rows[0])
    throw fail(403, 'BUDGET_POLICY_MISSING', '尚未配置已批准预算，不能调用模型，请联系维护人员。');
  const configured = found.rows[0];
  if (configured.environment !== (process.env.NODE_ENV ?? 'production'))
    throw fail(
      403,
      'BUDGET_ENVIRONMENT_MISMATCH',
      '预算环境与当前服务不一致，不能借用其他环境额度。',
    );
  return configured;
}
async function runContext(
  tx: PoolClient,
  reference: { runId: string; userId: string },
  active: boolean,
): Promise<RunContext> {
  const located = await tx.query<{
    conversation_id: string;
    goal_id: string | null;
    project_id: string | null;
  }>('SELECT conversation_id,goal_id,project_id FROM run WHERE id=$1 AND user_id=$2', [
    reference.runId,
    reference.userId,
  ]);
  const location = located.rows[0];
  if (!location) throw fail(403, 'BUDGET_RUN_FORBIDDEN', '计量运行不属于当前用户。');
  const users = await tx.query<{
    id: string;
    username: string;
    display_name: string;
    is_development: boolean;
    is_management: boolean;
    status: string;
  }>(
    'SELECT id,username,display_name,is_development,is_management,status FROM app_user WHERE id=$1 FOR SHARE',
    [reference.userId],
  );
  const user = users.rows[0];
  if (!user) throw fail(403, 'BUDGET_RUN_FORBIDDEN', '计量用户不存在。');
  let goalBudgetNano = 0n;
  let goalState: string | null = null;
  let direction: number | null = null;
  if (location.goal_id) {
    const goals = await tx.query<{
      budget_usd: string;
      status: string;
      direction_version: number;
      project_id: string;
    }>('SELECT budget_usd,status,direction_version,project_id FROM goal WHERE id=$1 FOR UPDATE', [
      location.goal_id,
    ]);
    const goal = goals.rows[0];
    if (!goal || goal.project_id !== location.project_id)
      throw fail(403, 'BUDGET_CONTEXT_MISMATCH', '运行与目标归属不一致。');
    goalBudgetNano = usdToNano(goal.budget_usd);
    goalState = goal.status;
    direction = goal.direction_version;
  }
  const conversations = await tx.query<{
    user_id: string;
    project_id: string | null;
    goal_id: string | null;
    status: string;
  }>('SELECT user_id,project_id,goal_id,status FROM conversation WHERE id=$1 FOR UPDATE', [
    location.conversation_id,
  ]);
  const conversation = conversations.rows[0];
  const runs = await tx.query<Omit<RunContext, 'goalBudgetNano'>>(
    'SELECT id,conversation_id,user_id,project_id,goal_id,direction_version,status,budget_steps,budget_total_tokens,budget_cost_nano FROM run WHERE id=$1 FOR UPDATE',
    [reference.runId],
  );
  const run = runs.rows[0];
  if (
    !run ||
    !conversation ||
    run.user_id !== reference.userId ||
    conversation.user_id !== reference.userId ||
    run.conversation_id !== location.conversation_id ||
    run.project_id !== conversation.project_id ||
    run.goal_id !== conversation.goal_id
  )
    throw fail(403, 'BUDGET_CONTEXT_MISMATCH', '运行与会话、项目或目标不一致，已拒绝计量调用。');
  if (active) {
    if (
      user.status !== 'active' ||
      (process.env.NODE_ENV === 'production' && user.is_development) ||
      run.status !== 'running' ||
      conversation.status !== 'active'
    )
      throw fail(409, 'BUDGET_RUN_INACTIVE', '用户、运行或对话已停止，不能发出新模型请求。');
    if (!run.goal_id || goalState !== 'active' || direction !== run.direction_version)
      throw fail(
        409,
        'BUDGET_GOAL_INACTIVE',
        '模型调用需要当前方向的活动目标，请负责人确认后重新运行。',
      );
    const actor = agentIdentitySchema.parse({
      kind: 'agent',
      runId: run.id,
      userId: user.id,
      username: user.username,
      displayName: user.display_name,
      isDevelopment: user.is_development,
      isManagement: user.is_management,
    });
    const projects = await tx.query<{ owner_user_id: string }>(
      'SELECT owner_user_id FROM cert_project WHERE id=$1 FOR SHARE',
      [run.project_id],
    );
    if (
      !projects.rows[0] ||
      !authorize(actor, 'project.read', {
        projectId: run.project_id,
        ownerUserId: projects.rows[0].owner_user_id,
      }) ||
      !authorize(actor, 'conversation.read', {
        projectId: run.project_id,
        ownerUserId: run.user_id,
      })
    )
      throw fail(
        403,
        'BUDGET_SCOPE_FORBIDDEN',
        '当前用户已无权访问运行所属项目或对话，不能继续调用模型。',
      );
  }
  return { ...run, goalBudgetNano };
}
async function stop(tx: PoolClient, runId: string, reason: string, global = false) {
  if (global)
    await tx.query(
      "UPDATE budget_policy SET blocked_reason=COALESCE(blocked_reason,$1),version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id='default'",
      [reason],
    );
  const affected = await tx.query<{ id: string; conversation_id: string; user_id: string }>(
    "UPDATE run SET status='budget_exhausted',budget_stop_reason=$1,finished_at=COALESCE(finished_at,CURRENT_TIMESTAMP),version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$2 AND status IN ('running','waiting','queued') RETURNING id,conversation_id,user_id",
    [reason, runId],
  );
  for (const row of affected.rows) {
    await stopRunVerifications(tx, {
      runId: row.id,
      conversationId: row.conversation_id,
      userId: row.user_id,
    });
    await cancelVerificationWaitsTx(tx, row.id, row.user_id);
    await stopReviewVerificationTx(tx, row.id, row.conversation_id, row.user_id);
    await cancelGoalWaitTx(tx, row.id);
    await finishGoalWakeTx(tx, row.id, false);
    await tx.query(
      "INSERT INTO audit_log(actor_kind,action,target_type,target_id) VALUES('system',$1,'run',$2)",
      [`budget.stop_${reason}`, row.id],
    );
  }
  return affected.rowCount ?? 0;
}

function warnHandoffDeferred() {
  try {
    console.warn('BUDGET_HANDOFF_DEFERRED');
  } catch {
    // 日志出口故障也不能使已经提交的模型费用看起来未结算。
  }
}

async function recordHandoffFailure(pool: Pool, runId?: string) {
  try {
    await pool.query(
      "INSERT INTO audit_log(actor_kind,action,target_type,target_id) VALUES('system','budget.handoff_failed',$1,$2)",
      [runId ? 'run' : 'budget_policy', runId ?? 'default'],
    );
  } catch {
    warnHandoffDeferred();
  }
}

/** 可由 worker 显式重扫；失败只产生固定告警，永远不改变先前已提交的计量结果。 */
export async function handoffBlockedBudgetRuns(pool: Pool) {
  const outcome = { stopped: 0, failed: 0, hasMore: false };
  try {
    const found = await pool.query<{
      blocked_reason: string | null;
      environment: string;
      version: number;
    }>("SELECT blocked_reason,environment,version FROM budget_policy WHERE id='default'");
    const configured = found.rows[0];
    if (!configured?.blocked_reason) return outcome;
    if (!enforceCostLimits(configured.environment) && configured.blocked_reason !== 'manual_check')
      return outcome;
    if (configured.environment !== (process.env.NODE_ENV ?? 'production')) {
      outcome.failed = 1;
      await recordHandoffFailure(pool);
      return outcome;
    }
    const reason = [
      'month_limit',
      'night_limit',
      'reservation_exceeded',
      'metering_incomplete',
    ].includes(configured.blocked_reason)
      ? configured.blocked_reason
      : 'global_policy_blocked';
    const candidates = await pool.query<{ id: string; user_id: string }>(
      "SELECT id,user_id FROM run WHERE status IN ('queued','running','waiting') ORDER BY id LIMIT 65",
    );
    outcome.hasMore = candidates.rows.length > 64;
    const deadline = Date.now() + 2000;
    for (const candidate of candidates.rows.slice(0, 64)) {
      if (Date.now() >= deadline) {
        outcome.hasMore = true;
        break;
      }
      try {
        outcome.stopped += await transaction(
          pool,
          async (tx) => {
            await tx.query("SET LOCAL lock_timeout='500ms'");
            await tx.query("SET LOCAL statement_timeout='2000ms'");
            const stillBlocked = await tx.query(
              "SELECT id FROM budget_policy WHERE id='default' AND version=$1 AND blocked_reason=$2 FOR SHARE",
              [configured.version, configured.blocked_reason],
            );
            if (!stillBlocked.rowCount) return 0;
            // 逐个新事务按 user→goal→conversation→run 加锁，不带入任何前一运行的锁。
            await runContext(tx, { runId: candidate.id, userId: candidate.user_id }, false);
            return stop(tx, candidate.id, reason);
          },
          false,
        );
      } catch {
        outcome.failed += 1;
        await recordHandoffFailure(pool, candidate.id);
      }
    }
  } catch {
    outcome.failed += 1;
    await recordHandoffFailure(pool);
  }
  return outcome;
}
async function totals(
  tx: PoolClient,
  column: 'run_id' | 'goal_id' | 'month_key' | 'night_key',
  value: string,
) {
  const result = await tx.query<{
    charged: string;
    reserved: string;
    tokens: string;
    settled_tokens: string;
    reserved_tokens: string;
    settled_steps: string;
    reserved_steps: string;
  }>(
    `SELECT COALESCE(SUM(CASE WHEN status='settled' THEN actual_nano ELSE 0 END),0)::text AS charged,
    COALESCE(SUM(CASE WHEN status IN ('reserved','unknown') THEN reserved_nano ELSE 0 END),0)::text AS reserved,
    COALESCE(SUM(CASE WHEN status='settled' THEN COALESCE(input_tokens+output_tokens,estimated_input_tokens+max_output_tokens) WHEN status IN ('reserved','unknown') THEN estimated_input_tokens+max_output_tokens ELSE 0 END),0)::text AS tokens,
    COALESCE(SUM(CASE WHEN status='settled' THEN COALESCE(input_tokens+output_tokens,estimated_input_tokens+max_output_tokens) ELSE 0 END),0)::text AS settled_tokens,
    COALESCE(SUM(CASE WHEN status IN ('reserved','unknown') THEN estimated_input_tokens+max_output_tokens ELSE 0 END),0)::text AS reserved_tokens,
    COUNT(*) FILTER(WHERE status='settled')::text AS settled_steps,
    COUNT(*) FILTER(WHERE status IN ('reserved','unknown'))::text AS reserved_steps
    FROM usage_ledger WHERE policy_id='default' AND ${column}=$1`,
    [value],
  );
  const row = result.rows[0]!;
  return {
    charged: BigInt(row.charged),
    reserved: BigInt(row.reserved),
    tokens: BigInt(row.tokens),
    settledTokens: BigInt(row.settled_tokens),
    reservedTokens: BigInt(row.reserved_tokens),
    settledSteps: Number(row.settled_steps),
    reservedSteps: Number(row.reserved_steps),
    occupied: BigInt(row.charged) + BigInt(row.reserved),
  };
}
async function currentMonth(tx: PoolClient) {
  const now = await tx.query<{ now: Date }>('SELECT CURRENT_TIMESTAMP AS now');
  return pickBeijingMonth(now.rows[0]!.now);
}
function reservation(row: Ledger, newReservation = false) {
  return budgetReservationSchema.parse({
    id: row.id,
    status: row.status,
    reservedNano: row.reserved_nano,
    dispatchAllowed: newReservation,
    newReservation,
  });
}
async function ledger(tx: PoolClient, reference: Identity) {
  const result = await tx.query<Ledger>(
    'SELECT * FROM usage_ledger WHERE request_key=$1 FOR UPDATE',
    [reference.requestKey],
  );
  const row = result.rows[0];
  if (!row || row.run_id !== reference.runId || row.user_id !== reference.userId)
    throw fail(403, 'BUDGET_REQUEST_FORBIDDEN', '计量请求不存在或不属于当前运行。');
  return row;
}

export async function seedDevelopmentBudgetPolicy(pool: Pool, environment: unknown) {
  const parsed = developmentBudgetEnvironmentSchema.safeParse(environment);
  if (!parsed.success)
    throw fail(403, 'BUDGET_SEED_FORBIDDEN', '默认预算种子仅允许开发或测试，生产需要单独批准。');
  await pool.query(
    `INSERT INTO budget_policy(id,environment,night_key,run_limit_nano,month_limit_nano,night_limit_nano,max_steps,max_tokens,alert_percent)
    VALUES('default',$1,'2026-11-17-overnight',1000000000,9000000000,10000000000,60,400000,80) ON CONFLICT(id) DO NOTHING`,
    [parsed.data],
  );
}

export async function reserveUsage(pool: Pool, input: unknown): Promise<BudgetReservation> {
  const identity = referenceSchema.safeParse(input);
  if (!identity.success) throw invalid();
  const parsed = budgetReserveSchema.safeParse(input);
  if (!parsed.success) {
    const prices =
      typeof input === 'object' && input !== null && 'prices' in input ? input.prices : undefined;
    if (!budgetPricesSchema.safeParse(prices).success)
      return transaction<never>(pool, async (tx) => {
        await policy(tx);
        await runContext(tx, identity.data, true);
        await stop(tx, identity.data.runId, 'missing_price');
        return new Rejection(
          fail(
            403,
            'BUDGET_PRICE_UNKNOWN',
            '模型价格缺失或无效，已记录计量不完整并停止当前运行；不会发出请求或自动追加调用。',
          ),
        );
      });
    throw invalid();
  }
  const data = parsed.data;
  const requestFingerprint = fingerprint(data);
  return transaction<BudgetReservation>(pool, async (tx) => {
    const configured = await policy(tx);
    const run = await runContext(tx, data, true);
    const existing = await tx.query<Ledger>(
      'SELECT * FROM usage_ledger WHERE request_key=$1 FOR UPDATE',
      [data.requestKey],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (
        row.run_id !== run.id ||
        row.user_id !== data.userId ||
        row.request_fingerprint !== requestFingerprint
      )
        throw fail(
          409,
          'BUDGET_IDEMPOTENCY_CONFLICT',
          '同一计量请求编号的模型、用途、价格或限额发生变化，不能重发。',
        );
      return reservation(row);
    }
    const limited = enforceCostLimits(configured.environment);
    const unknown =
      limited &&
      (
        await tx.query(
          "SELECT 1 FROM usage_ledger WHERE policy_id='default' AND status='unknown' LIMIT 1",
        )
      ).rowCount;
    if (
      configured.blocked_reason === 'manual_check' ||
      (limited && (configured.blocked_reason || unknown))
    ) {
      await stop(tx, run.id, 'metering_incomplete');
      return new Rejection(
        fail(403, 'BUDGET_BLOCKED', '预算已冻结或存在未知费用，请负责人核对后再建立新运行。'),
      );
    }
    const conservativePrices = {
      ...data.prices,
      inputUsdPerMillion:
        usdToNano(data.prices.inputUsdPerMillion) >= usdToNano(data.prices.cacheReadUsdPerMillion)
          ? data.prices.inputUsdPerMillion
          : data.prices.cacheReadUsdPerMillion,
    };
    const estimated = estimateCostNano(
      {
        inputTokens: data.estimatedInputTokens,
        cacheReadTokens: 0,
        outputTokens: data.maxOutputTokens,
      },
      conservativePrices,
    );
    const month = await currentMonth(tx);
    const runUsage = await totals(tx, 'run_id', run.id),
      goalUsage = await totals(tx, 'goal_id', run.goal_id!),
      monthUsage = await totals(tx, 'month_key', month),
      nightUsage = await totals(tx, 'night_key', configured.night_key);
    const tokenUse =
      (BigInt(run.budget_total_tokens) > runUsage.settledTokens
        ? BigInt(run.budget_total_tokens)
        : runUsage.settledTokens) + runUsage.reservedTokens;
    const snapshotCost = BigInt(run.budget_cost_nano ?? '0');
    const occupiedRunCost =
      (snapshotCost > runUsage.charged ? snapshotCost : runUsage.charged) + runUsage.reserved;
    const occupiedSteps =
      Math.max(Number(run.budget_steps), runUsage.settledSteps) + runUsage.reservedSteps;
    let reason: string | null = null;
    if (occupiedSteps >= Number(configured.max_steps)) reason = 'steps';
    else if (
      limited &&
      tokenUse + BigInt(data.estimatedInputTokens) + BigInt(data.maxOutputTokens) >
        BigInt(configured.max_tokens)
    )
      reason = 'tokens';
    else if (
      limited &&
      (occupiedRunCost + estimated > BigInt(configured.run_limit_nano) ||
        occupiedRunCost >= BigInt(configured.run_limit_nano))
    )
      reason = 'run_limit';
    else if (
      limited &&
      (goalUsage.occupied + estimated > run.goalBudgetNano ||
        goalUsage.occupied >= run.goalBudgetNano)
    )
      reason = 'goal_limit';
    else if (
      limited &&
      (monthUsage.occupied + estimated > BigInt(configured.month_limit_nano) ||
        monthUsage.occupied >= BigInt(configured.month_limit_nano))
    )
      reason = 'month_limit';
    else if (
      limited &&
      (nightUsage.occupied + estimated > BigInt(configured.night_limit_nano) ||
        nightUsage.occupied >= BigInt(configured.night_limit_nano))
    )
      reason = 'night_limit';
    if (reason) {
      await stop(tx, run.id, reason, reason === 'month_limit' || reason === 'night_limit');
      return new Rejection(
        fail(
          403,
          'BUDGET_LIMIT_REACHED',
          limited
            ? '本次请求将超过步数、token或费用上限，已停止并交回负责人。请缩小任务后重新发起。'
            : '本轮达到步数上限，已停止继续调用。请查看已完成的步骤，分成更小的任务后继续。',
        ),
      );
    }
    const inserted = await tx.query<Ledger>(
      `INSERT INTO usage_ledger(request_key,policy_id,run_id,conversation_id,user_id,project_id,goal_id,model_id,purpose,month_key,night_key,status,reserved_nano,price_snapshot,request_fingerprint,estimated_input_tokens,max_output_tokens)
      VALUES($1,'default',$2,$3,$4,$5,$6,$7,$8,$9,$10,'reserved',$11,$12,$13,$14,$15) RETURNING *`,
      [
        data.requestKey,
        run.id,
        run.conversation_id,
        data.userId,
        run.project_id,
        run.goal_id,
        data.modelId,
        data.purpose,
        month,
        configured.night_key,
        estimated.toString(),
        data.prices,
        requestFingerprint,
        data.estimatedInputTokens,
        data.maxOutputTokens,
      ],
    );
    const threshold = BigInt(configured.alert_percent);
    if (
      limited &&
      ((monthUsage.occupied + estimated) * 100n >=
        BigInt(configured.month_limit_nano) * threshold ||
        (nightUsage.occupied + estimated) * 100n >= BigInt(configured.night_limit_nano) * threshold)
    )
      await tx.query(
        "INSERT INTO audit_log(actor_kind,action,target_type,target_id) VALUES('system','budget.threshold_reached','usage_ledger',$1)",
        [inserted.rows[0]!.id],
      );
    return reservation(inserted.rows[0]!, true);
  });
}

export async function settleUsage(pool: Pool, input: unknown) {
  const parsed = budgetSettleSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  const data = parsed.data;
  return transaction(pool, async (tx) => {
    const configured = await policy(tx);
    await runContext(tx, data, false);
    const row = await ledger(tx, data);
    const actual =
      data.actualCostNano === undefined
        ? estimateCostNano(
            {
              inputTokens: data.inputTokens,
              cacheReadTokens: data.cacheReadTokens,
              outputTokens: data.outputTokens,
            },
            row.price_snapshot,
          )
        : BigInt(data.actualCostNano);
    const usageFingerprint = fingerprint({
      inputTokens: data.inputTokens,
      cacheReadTokens: data.cacheReadTokens,
      outputTokens: data.outputTokens,
      actualCostNano: actual.toString(),
    });
    if (row.status === 'settled') {
      if (row.settlement_fingerprint !== usageFingerprint)
        throw fail(
          409,
          'BUDGET_SETTLEMENT_CONFLICT',
          '同一调用的用量回执发生变化，请人工对账，不能重复扣算。',
        );
      return {
        id: row.id,
        status: 'settled' as const,
        actualNano: row.actual_nano!,
        replayed: true,
      };
    }
    if (row.status === 'not_sent')
      throw fail(
        409,
        'BUDGET_SETTLEMENT_CONFLICT',
        '该请求已经确认未发送，不能直接覆盖其计量结论。',
      );
    await tx.query(
      "UPDATE usage_ledger SET status='settled',actual_nano=$1,input_tokens=$2,cache_read_tokens=$3,output_tokens=$4,settlement_fingerprint=$5,updated_at=CURRENT_TIMESTAMP WHERE id=$6",
      [
        actual.toString(),
        data.inputTokens,
        data.cacheReadTokens,
        data.outputTokens,
        usageFingerprint,
        row.id,
      ],
    );
    await tx.query(
      "INSERT INTO audit_log(actor_kind,action,target_type,target_id) VALUES('system','budget.settled','usage_ledger',$1)",
      [row.id],
    );
    const limited = enforceCostLimits(configured.environment);
    if (limited && actual > BigInt(row.reserved_nano))
      await stop(tx, row.run_id, 'reservation_exceeded', true);
    else if (limited) {
      const monthly = await totals(tx, 'month_key', row.month_key),
        night = await totals(tx, 'night_key', row.night_key);
      if (monthly.occupied >= BigInt(configured.month_limit_nano))
        await stop(tx, row.run_id, 'month_limit', true);
      else if (night.occupied >= BigInt(configured.night_limit_nano))
        await stop(tx, row.run_id, 'night_limit', true);
      else {
        const cost = await totals(tx, 'run_id', row.run_id);
        if (cost.occupied >= BigInt(configured.run_limit_nano))
          await stop(tx, row.run_id, 'run_limit');
      }
    }
    return {
      id: row.id,
      status: 'settled' as const,
      actualNano: actual.toString(),
      replayed: false,
    };
  });
}

export async function markUsageIncomplete(pool: Pool, input: unknown) {
  const parsed = budgetIncompleteSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  const data = parsed.data;
  return transaction(pool, async (tx) => {
    const configured = await policy(tx);
    await runContext(tx, data, false);
    const row = await ledger(tx, data);
    if (row.status === 'settled' || row.status === 'not_sent')
      throw fail(409, 'BUDGET_STATE_CONFLICT', '已完成的计量不能改为未知，请核对对应请求编号。');
    if (row.status !== 'unknown')
      await tx.query(
        "UPDATE usage_ledger SET status='unknown',reason_code=$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2",
        [data.reasonCode, row.id],
      );
    if (enforceCostLimits(configured.environment))
      await stop(tx, row.run_id, 'metering_incomplete', true);
    else if (row.status !== 'unknown')
      await tx.query(
        "INSERT INTO audit_log(actor_kind,action,target_type,target_id) VALUES('system','budget.usage_pending','usage_ledger',$1)",
        [row.id],
      );
    return { id: row.id, status: 'unknown' as const, reservedNano: row.reserved_nano };
  });
}

export async function markUsageNotDispatched(pool: Pool, input: unknown) {
  const reference = referenceSchema.safeParse(input);
  if (!reference.success) throw invalid();
  return transaction(pool, async (tx) => {
    await policy(tx);
    await runContext(tx, reference.data, false);
    const row = await ledger(tx, reference.data);
    if (row.status === 'not_sent') return;
    if (row.status !== 'reserved')
      throw fail(409, 'BUDGET_STATE_CONFLICT', '无法确认预占仍未发送，请核对账本。');
    await tx.query(
      "UPDATE usage_ledger SET status='not_sent',actual_nano=0,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
      [row.id],
    );
    await tx.query(
      "INSERT INTO audit_log(actor_kind,action,target_type,target_id) VALUES('system','budget.not_dispatched','usage_ledger',$1)",
      [row.id],
    );
  });
}

export async function meteringCanResume(pool: Pool, ledgerIds: string[], environment: string) {
  const result = await pool.query<{ resolved: number }>(
    `SELECT COUNT(*)::integer AS resolved FROM usage_ledger u
     JOIN budget_policy p ON p.id=u.policy_id
     WHERE p.id='default' AND p.environment=$2
       AND (p.blocked_reason IS NULL OR (NOT $3 AND p.blocked_reason<>'manual_check'))
       AND u.id=ANY($1::uuid[]) AND u.status IN ('settled','not_sent')`,
    [ledgerIds, environment, enforceCostLimits(environment)],
  );
  return result.rows[0]?.resolved === ledgerIds.length;
}

async function resolveMeteringStop(tx: PoolClient, configured: Policy) {
  if (configured.blocked_reason !== 'metering_incomplete') return configured.blocked_reason;
  const pending = await tx.query(
    "SELECT id FROM usage_ledger WHERE policy_id=$1 AND status IN ('unknown','reserved') LIMIT 1",
    [configured.id],
  );
  if (pending.rowCount) return configured.blocked_reason;

  const month = await currentMonth(tx);
  const overage = await tx.query(
    `SELECT id FROM usage_ledger WHERE policy_id=$1 AND status='settled'
     AND (month_key=$2 OR night_key=$3) AND actual_nano>reserved_nano LIMIT 1`,
    [configured.id, month, configured.night_key],
  );
  const monthly = await totals(tx, 'month_key', month);
  const nightly = await totals(tx, 'night_key', configured.night_key);
  let reason: string | null = null;
  if (overage.rowCount) reason = 'reservation_exceeded';
  else if (monthly.occupied >= BigInt(configured.month_limit_nano)) reason = 'month_limit';
  else if (nightly.occupied >= BigInt(configured.night_limit_nano)) reason = 'night_limit';

  await tx.query(
    'UPDATE budget_policy SET blocked_reason=$1,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$2',
    [reason, configured.id],
  );
  await tx.query(
    "INSERT INTO audit_log(actor_kind,action,target_type,target_id,before_hash,after_hash) VALUES('system','budget.reconciliation_policy_changed','budget_policy',$1,$2,$3)",
    [
      configured.id,
      fingerprint({ blockedReason: configured.blocked_reason }),
      fingerprint({ blockedReason: reason }),
    ],
  );
  return reason;
}

export async function reconcileUsage(pool: Pool, input: unknown) {
  const parsed = budgetReconcileSchema.safeParse(input);
  if (!parsed.success)
    throw fail(400, 'BUDGET_RECONCILIATION_INVALID', '核账参数无效，请检查账本编号、结果和依据。');
  const data = parsed.data;
  const commandFingerprint = fingerprint(data);
  return transaction(pool, async (tx) => {
    const configured = await policy(tx);
    const row = (
      await tx.query<Ledger>('SELECT * FROM usage_ledger WHERE id=$1 AND policy_id=$2 FOR UPDATE', [
        data.ledgerId,
        configured.id,
      ])
    ).rows[0];
    if (!row) throw fail(404, 'BUDGET_LEDGER_NOT_FOUND', '找不到该预算账本记录，请核对编号。');
    const previous = (
      await tx.query<{ fingerprint: string }>(
        'SELECT fingerprint FROM budget_reconciliation WHERE ledger_id=$1',
        [row.id],
      )
    ).rows[0];
    if (previous?.fingerprint === commandFingerprint) {
      const blockedReason = await resolveMeteringStop(tx, configured);
      return {
        ledgerId: row.id,
        outcome: data.outcome,
        costNano: row.actual_nano!,
        blockedReason,
        replayed: true,
      };
    }
    if (previous || row.status !== 'unknown')
      throw fail(
        409,
        'BUDGET_RECONCILIATION_CONFLICT',
        '只能核对未知用量，已经结算的记录不能改写。请核对账本编号和原核账依据。',
      );

    const costNano =
      data.outcome === 'charged'
        ? data.actualCostNano
        : data.outcome === 'reserved_estimate'
          ? row.reserved_nano
          : '0';
    const usage =
      data.outcome === 'charged'
        ? {
            inputTokens: data.inputTokens,
            cacheReadTokens: data.cacheReadTokens,
            outputTokens: data.outputTokens,
          }
        : { inputTokens: null, cacheReadTokens: null, outputTokens: null };
    const settlementFingerprint =
      data.outcome === 'charged'
        ? fingerprint({ ...usage, actualCostNano: costNano })
        : commandFingerprint;
    await tx.query(
      'INSERT INTO budget_reconciliation(ledger_id,outcome,evidence,fingerprint) VALUES($1,$2,$3,$4)',
      [row.id, data.outcome, data.evidence, commandFingerprint],
    );
    await tx.query(
      `UPDATE usage_ledger SET status=$1,actual_nano=$2,input_tokens=$3,cache_read_tokens=$4,
       output_tokens=$5,settlement_fingerprint=$6,settled_by_estimate=$7,updated_at=CURRENT_TIMESTAMP WHERE id=$8`,
      [
        data.outcome === 'not_sent' ? 'not_sent' : 'settled',
        costNano,
        usage.inputTokens,
        usage.cacheReadTokens,
        usage.outputTokens,
        settlementFingerprint,
        data.outcome === 'reserved_estimate',
        row.id,
      ],
    );
    await tx.query(
      "INSERT INTO audit_log(actor_kind,action,target_type,target_id,before_hash,after_hash) VALUES('system','budget.reconciled','usage_ledger',$1,$2,$3)",
      [
        row.id,
        fingerprint({ status: row.status, reservedNano: row.reserved_nano }),
        commandFingerprint,
      ],
    );
    const blockedReason = await resolveMeteringStop(tx, configured);
    return { ledgerId: row.id, outcome: data.outcome, costNano, blockedReason, replayed: false };
  });
}

export async function recordCumulativeUsage(pool: Pool, reference: unknown, snapshot: unknown) {
  const identity = contextSchema.safeParse(reference),
    parsed = cumulativeUsageSchema.safeParse(snapshot);
  if (!identity.success || !parsed.success) throw invalid();
  return transaction(pool, async (tx) => {
    const configured = await policy(tx);
    const run = await runContext(tx, identity.data, false);
    const data = parsed.data;
    if (
      BigInt(data.steps) < BigInt(run.budget_steps) ||
      BigInt(data.totalTokens) < BigInt(run.budget_total_tokens) ||
      (data.costNano !== null &&
        run.budget_cost_nano !== null &&
        BigInt(data.costNano) < BigInt(run.budget_cost_nano))
    )
      throw fail(
        409,
        'BUDGET_CUMULATIVE_STALE',
        '累计用量不能退回较小快照，请使用Pi当前完整累计值。',
      );
    await tx.query(
      'UPDATE run SET budget_steps=$1,budget_total_tokens=$2,budget_cost_nano=$3,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$4',
      [data.steps, data.totalTokens, data.costNano, run.id],
    );
    const decision = enforceCostLimits(configured.environment)
      ? evaluateCumulativeBudget(data, {
          maxSteps: Number(configured.max_steps),
          maxTokens: Number(configured.max_tokens),
          maxCostNano: configured.run_limit_nano,
        })
      : {
          stop: data.steps >= Number(configured.max_steps),
          reason: data.steps >= Number(configured.max_steps) ? ('steps' as const) : null,
        };
    if (decision.stop)
      await stop(tx, run.id, decision.reason!, decision.reason === 'metering_incomplete');
    return {
      steps: data.steps,
      totalTokens: data.totalTokens,
      costNano: data.costNano,
      stopped: decision.stop,
      reason: decision.reason,
    };
  });
}

export async function getBudgetSummary(pool: Pool) {
  const found = await pool.query<Policy>("SELECT * FROM budget_policy WHERE id='default'");
  const configured = found.rows[0];
  if (!configured)
    throw fail(
      403,
      'BUDGET_POLICY_MISSING',
      '尚未配置预算，请先完成开发种子或由负责人配置生产额度。',
    );
  const monthKey = pickBeijingMonth(new Date());
  const rows = await pool.query<{
    month_cost: string;
    month_reserved: string;
    month_estimated: string;
    night_cost: string;
    night_reserved: string;
    night_estimated: string;
    reserved: string;
    settled: string;
    unknown: string;
    not_sent: string;
    settled_estimated: string;
  }>(
    `SELECT
    COALESCE(SUM(actual_nano) FILTER(WHERE status='settled' AND month_key=$1),0)::text AS month_cost,
    COALESCE(SUM(reserved_nano) FILTER(WHERE status IN ('reserved','unknown') AND month_key=$1),0)::text AS month_reserved,
    COALESCE(SUM(actual_nano) FILTER(WHERE settled_by_estimate AND month_key=$1),0)::text AS month_estimated,
    COALESCE(SUM(actual_nano) FILTER(WHERE status='settled' AND night_key=$2),0)::text AS night_cost,
    COALESCE(SUM(reserved_nano) FILTER(WHERE status IN ('reserved','unknown') AND night_key=$2),0)::text AS night_reserved,
    COALESCE(SUM(actual_nano) FILTER(WHERE settled_by_estimate AND night_key=$2),0)::text AS night_estimated,
    COUNT(*) FILTER(WHERE status='reserved')::text AS reserved,
    COUNT(*) FILTER(WHERE status='settled')::text AS settled,
    COUNT(*) FILTER(WHERE status='unknown')::text AS unknown,
    COUNT(*) FILTER(WHERE status='not_sent')::text AS not_sent,
    COUNT(*) FILTER(WHERE settled_by_estimate)::text AS settled_estimated
    FROM usage_ledger WHERE policy_id='default'`,
    [monthKey, configured.night_key],
  );
  const row = rows.rows[0]!;
  const costLimitsEnforced = enforceCostLimits(configured.environment);
  return {
    monthKey,
    nightKey: configured.night_key,
    costLimitsEnforced,
    runLimitNano: configured.run_limit_nano,
    monthLimitNano: configured.month_limit_nano,
    nightLimitNano: configured.night_limit_nano,
    monthCostNano: row.month_cost,
    monthReservedNano: row.month_reserved,
    monthEstimatedNano: row.month_estimated,
    nightCostNano: row.night_cost,
    nightReservedNano: row.night_reserved,
    nightEstimatedNano: row.night_estimated,
    settledEstimatedCount: Number(row.settled_estimated),
    blockedReason:
      costLimitsEnforced || configured.blocked_reason === 'manual_check'
        ? configured.blocked_reason
        : null,
    counts: {
      reserved: Number(row.reserved),
      settled: Number(row.settled),
      unknown: Number(row.unknown),
      notSent: Number(row.not_sent),
    },
  };
}
