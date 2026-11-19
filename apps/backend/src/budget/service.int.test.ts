import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createIntegrationContext } from '../test-support/context.js';
import {
  seedDevelopmentBudgetPolicy,
  reserveUsage,
  settleUsage,
  markUsageIncomplete,
  reconcileUsage,
  recordCumulativeUsage,
  getBudgetSummary,
} from './service.js';

let context: Awaited<ReturnType<typeof createIntegrationContext>>;
const prices = { inputUsdPerMillion: '10', cacheReadUsdPerMillion: '5', outputUsdPerMillion: '20' };
async function request(overrides: Record<string, unknown> = {}) {
  const run = await context.run();
  return {
    requestKey: randomUUID(),
    runId: run.runId,
    userId: run.userId,
    modelId: 'scripted/budget-test',
    purpose: 'evaluation',
    estimatedInputTokens: 10000,
    maxOutputTokens: 5000,
    prices,
    ...overrides,
  };
}
beforeEach(async () => {
  context = await createIntegrationContext();
  await seedDevelopmentBudgetPolicy(context.pool, 'test');
});
afterEach(async () => {
  if (context) await context.close();
});

test('默认预算种子只用于非生产且不重置既有额度、冻结或批次', async () => {
  await expect(seedDevelopmentBudgetPolicy(context.pool, 'production')).rejects.toMatchObject({
    code: 'BUDGET_SEED_FORBIDDEN',
  });
  const initial = await getBudgetSummary(context.pool);
  expect(initial.runLimitNano).toBe('1000000000');
  expect(initial.monthLimitNano).toBe('9000000000');
  expect(initial.nightLimitNano).toBe('10000000000');
  const limits = (await context.pool.query('SELECT max_steps,max_tokens FROM budget_policy'))
    .rows[0];
  expect(Number(limits.max_steps)).toBe(60);
  expect(Number(limits.max_tokens)).toBe(400000);
  await context.pool.query(
    "UPDATE budget_policy SET blocked_reason='manual_check',month_limit_nano=8000000000 WHERE id='default'",
  );
  await seedDevelopmentBudgetPolicy(context.pool, 'test');
  const repeated = await getBudgetSummary(context.pool);
  expect(repeated.blockedReason).toBe('manual_check');
  expect(repeated.monthLimitNano).toBe('8000000000');
  expect(repeated.nightKey).toBe(initial.nightKey);
});

test('同调用并发预占只有一次派发许可，绑定模型价格和请求参数', async () => {
  const input = await request();
  const reserved = await Promise.all([
    reserveUsage(context.pool, input),
    reserveUsage(context.pool, { ...input }),
  ]);
  expect(reserved.filter((row) => row.dispatchAllowed)).toHaveLength(1);
  expect(reserved[0].id).toBe(reserved[1].id);
  expect(reserved[0].reservedNano).toBe('200000000');
  await expect(
    reserveUsage(context.pool, { ...input, modelId: 'scripted/changed' }),
  ).rejects.toMatchObject({ code: 'BUDGET_IDEMPOTENCY_CONFLICT' });
  const summary = await getBudgetSummary(context.pool);
  expect(summary.counts.reserved).toBe(1);
  expect(summary.nightReservedNano).toBe('200000000');
  expect(summary.nightCostNano).toBe('0');
});

test('实际缓存用量精确结算，重复回执和Pi累计快照不会重复累加费用', async () => {
  const input = await request();
  await reserveUsage(context.pool, input);
  const usage = {
    requestKey: input.requestKey,
    runId: input.runId,
    userId: input.userId,
    inputTokens: 10000,
    cacheReadTokens: 4000,
    outputTokens: 1000,
  };
  const first = await settleUsage(context.pool, usage);
  expect(first.actualNano).toBe('100000000');
  await expect(
    context.pool.query(
      "INSERT INTO budget_reconciliation(ledger_id,outcome,evidence,fingerprint) VALUES($1,'charged','已结算记录追加依据测试',$2)",
      [first.id, 'b'.repeat(64)],
    ),
  ).rejects.toMatchObject({ code: '42501' });
  expect((await settleUsage(context.pool, usage)).replayed).toBe(true);
  await expect(settleUsage(context.pool, { ...usage, outputTokens: 1001 })).rejects.toMatchObject({
    code: 'BUDGET_SETTLEMENT_CONFLICT',
  });
  const snapshot = { steps: 1, totalTokens: 11000, costNano: '100000000' };
  await recordCumulativeUsage(context.pool, { runId: input.runId, userId: input.userId }, snapshot);
  await recordCumulativeUsage(context.pool, { runId: input.runId, userId: input.userId }, snapshot);
  const run = (
    await context.pool.query(
      'SELECT budget_steps,budget_total_tokens,budget_cost_nano FROM run WHERE id=$1',
      [input.runId],
    )
  ).rows[0];
  expect(Number(run.budget_steps)).toBe(1);
  expect(Number(run.budget_total_tokens)).toBe(11000);
  expect(run.budget_cost_nano).toBe('100000000');
  const summary = await getBudgetSummary(context.pool);
  expect(summary.nightCostNano).toBe('100000000');
  expect(summary.nightReservedNano).toBe('0');
});

test('目标累计预算的并发请求不能同时越过共享额度', async () => {
  await context.pool.query('UPDATE goal SET budget_usd=1 WHERE id=$1', [context.goalId]);
  const rate = {
    inputUsdPerMillion: '7500',
    cacheReadUsdPerMillion: '7500',
    outputUsdPerMillion: '0',
  };
  const first = await request({ estimatedInputTokens: 100, maxOutputTokens: 0, prices: rate }),
    second = await request({ estimatedInputTokens: 100, maxOutputTokens: 0, prices: rate });
  const results = await Promise.allSettled([
    reserveUsage(context.pool, first),
    reserveUsage(context.pool, second),
  ]);
  expect(results.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((value) => value.status === 'rejected')).toHaveLength(1);
  expect((await getBudgetSummary(context.pool)).nightReservedNano).toBe('750000000');
});

test.each(['month', 'night'])('%s上限拒绝新请求并交回运行，调高额度不自动恢复', async (scope) => {
  await context.pool.query(
    `UPDATE budget_policy SET ${scope === 'month' ? 'month_limit_nano' : 'night_limit_nano'}=300000000 WHERE id='default'`,
  );
  const first = await request(),
    second = await request();
  await reserveUsage(context.pool, first);
  await expect(reserveUsage(context.pool, second)).rejects.toMatchObject({
    code: 'BUDGET_LIMIT_REACHED',
  });
  const summary = await getBudgetSummary(context.pool);
  expect(summary.blockedReason).toBe(`${scope}_limit`);
  expect(
    (await context.pool.query('SELECT status FROM run WHERE id=$1', [first.runId])).rows[0].status,
  ).toBe('budget_exhausted');
  await context.pool.query(
    "UPDATE budget_policy SET month_limit_nano=9000000000,night_limit_nano=10000000000 WHERE id='default'",
  );
  await expect(
    reserveUsage(context.pool, { ...second, requestKey: randomUUID() }),
  ).rejects.toMatchObject({ code: 'BUDGET_RUN_INACTIVE' });
});

test('缺价格在发出前停机并记录，不伪造零费用账目', async () => {
  const input = await request();
  await expect(
    reserveUsage(context.pool, { ...input, prices: { ...prices, outputUsdPerMillion: undefined } }),
  ).rejects.toMatchObject({ code: 'BUDGET_PRICE_UNKNOWN' });
  const run = (
    await context.pool.query('SELECT status,budget_stop_reason FROM run WHERE id=$1', [input.runId])
  ).rows[0];
  expect(run).toEqual({ status: 'budget_exhausted', budget_stop_reason: 'missing_price' });
  expect(
    (
      await context.pool.query(
        "SELECT id FROM audit_log WHERE action='budget.stop_missing_price' AND target_id=$1",
        [input.runId],
      )
    ).rowCount,
  ).toBe(1);
  expect((await context.pool.query('SELECT id FROM usage_ledger')).rowCount).toBe(0);
});

test('发送后未知用量保留全部预占并全局停止，后补费用不会自动解冻', async () => {
  const input = await request();
  await reserveUsage(context.pool, input);
  await markUsageIncomplete(context.pool, {
    requestKey: input.requestKey,
    runId: input.runId,
    userId: input.userId,
    reasonCode: 'timeout',
  });
  const unknown = await getBudgetSummary(context.pool);
  expect(unknown.nightReservedNano).toBe('200000000');
  expect(unknown.counts.unknown).toBe(1);
  expect(unknown.blockedReason).toBe('metering_incomplete');
  const another = await request();
  await expect(reserveUsage(context.pool, another)).rejects.toMatchObject({
    code: 'BUDGET_BLOCKED',
  });
  const settled = await settleUsage(context.pool, {
    requestKey: input.requestKey,
    runId: input.runId,
    userId: input.userId,
    inputTokens: 1000,
    cacheReadTokens: 0,
    outputTokens: 100,
    actualCostNano: '12000000',
  });
  expect(settled.actualNano).toBe('12000000');
  const summary = await getBudgetSummary(context.pool);
  expect(summary.nightCostNano).toBe('12000000');
  expect(summary.nightReservedNano).toBe('0');
  expect(summary.blockedReason).toBe('metering_incomplete');
});

test.each([
  {
    outcome: 'charged',
    actualCostNano: '12000000',
    inputTokens: 1000,
    cacheReadTokens: 300,
    outputTokens: 100,
  },
  { outcome: 'not_sent' },
  { outcome: 'reserved_estimate' },
] as const)('核账 $outcome 写入财务结果与审计，重复操作不改账', async (outcome) => {
  const input = await request();
  const reserved = await reserveUsage(context.pool, input);
  await markUsageIncomplete(context.pool, {
    requestKey: input.requestKey,
    runId: input.runId,
    userId: input.userId,
    reasonCode: 'request_uncertain',
  });
  const command = { ledgerId: reserved.id, evidence: '隔离测试证据', ...outcome };
  const expected =
    outcome.outcome === 'charged'
      ? '12000000'
      : outcome.outcome === 'reserved_estimate'
        ? '200000000'
        : '0';
  const result = await reconcileUsage(context.pool, command);
  expect(result).toMatchObject({
    ledgerId: reserved.id,
    outcome: outcome.outcome,
    costNano: expected,
    blockedReason: null,
    replayed: false,
  });
  expect(await reconcileUsage(context.pool, command)).toMatchObject({ ...result, replayed: true });
  await expect(
    reconcileUsage(context.pool, { ...command, evidence: '改写既有依据' }),
  ).rejects.toMatchObject({ code: 'BUDGET_RECONCILIATION_CONFLICT' });
  const stored = (
    await context.pool.query(
      'SELECT actual_nano,input_tokens,cache_read_tokens,output_tokens,settled_by_estimate,status FROM usage_ledger WHERE id=$1',
      [reserved.id],
    )
  ).rows[0]!;
  expect(stored.actual_nano).toBe(expected);
  expect(stored.input_tokens).toBe(outcome.outcome === 'charged' ? '1000' : null);
  expect(stored.cache_read_tokens).toBe(outcome.outcome === 'charged' ? '300' : null);
  expect(stored.output_tokens).toBe(outcome.outcome === 'charged' ? '100' : null);
  expect(stored.settled_by_estimate).toBe(outcome.outcome === 'reserved_estimate');
  expect(stored.status).toBe(outcome.outcome === 'not_sent' ? 'not_sent' : 'settled');
  expect(
    (
      await context.pool.query(
        'SELECT outcome,evidence FROM budget_reconciliation WHERE ledger_id=$1',
        [reserved.id],
      )
    ).rows,
  ).toEqual([{ outcome: outcome.outcome, evidence: '隔离测试证据' }]);
  expect(
    (
      await context.pool.query(
        "SELECT id FROM audit_log WHERE target_id=$1 AND action='budget.reconciled'",
        [reserved.id],
      )
    ).rowCount,
  ).toBe(1);
  await expect(
    context.pool.query("UPDATE budget_reconciliation SET evidence='覆盖记录' WHERE ledger_id=$1", [
      reserved.id,
    ]),
  ).rejects.toMatchObject({ code: '42501' });
  const summary = await getBudgetSummary(context.pool);
  expect(summary.nightReservedNano).toBe('0');
  expect(summary.nightCostNano).toBe(expected);
  expect(summary.nightEstimatedNano).toBe(outcome.outcome === 'reserved_estimate' ? expected : '0');
});

test('还有未知调用时保持计量停止，全部核对后只允许新运行', async () => {
  const inputs = await Promise.all([request(), request()]);
  const reserved = [];
  for (const input of inputs) reserved.push(await reserveUsage(context.pool, input));
  for (const input of inputs) {
    await markUsageIncomplete(context.pool, {
      requestKey: input.requestKey,
      runId: input.runId,
      userId: input.userId,
      reasonCode: 'timeout',
    });
  }
  const command = { outcome: 'not_sent', evidence: '隔离测试证据' };
  expect(
    await reconcileUsage(context.pool, { ...command, ledgerId: reserved[0]!.id }),
  ).toMatchObject({ blockedReason: 'metering_incomplete' });
  expect((await getBudgetSummary(context.pool)).counts.unknown).toBe(1);
  expect(
    await reconcileUsage(context.pool, { ...command, ledgerId: reserved[1]!.id }),
  ).toMatchObject({ blockedReason: null });
  const runs = await context.pool.query('SELECT status FROM run WHERE id=ANY($1::uuid[])', [
    inputs.map((input) => input.runId),
  ]);
  expect(runs.rows.map((item) => item.status)).toEqual(['budget_exhausted', 'budget_exhausted']);
  expect(await reserveUsage(context.pool, await request())).toMatchObject({
    dispatchAllowed: true,
  });
});

test('还有在途预占时保留停机，重复原核账仅复核门禁', async () => {
  const missing = await request();
  const inFlight = await request();
  const reserved = await reserveUsage(context.pool, missing);
  await reserveUsage(context.pool, inFlight);
  await markUsageIncomplete(context.pool, {
    requestKey: missing.requestKey,
    runId: missing.runId,
    userId: missing.userId,
    reasonCode: 'missing_usage',
  });
  await expect(
    context.pool.query(
      "INSERT INTO budget_reconciliation(ledger_id,outcome,evidence,fingerprint) VALUES($1,'not_sent','独立写入测试',$2)",
      [reserved.id, 'a'.repeat(64)],
    ),
  ).rejects.toMatchObject({ code: '23514' });
  const command = { ledgerId: reserved.id, outcome: 'not_sent', evidence: '隔离测试未发送' };
  await expect(reconcileUsage(context.pool, command)).resolves.toMatchObject({
    blockedReason: 'metering_incomplete',
  });
  await settleUsage(context.pool, {
    requestKey: inFlight.requestKey,
    runId: inFlight.runId,
    userId: inFlight.userId,
    inputTokens: 1,
    cacheReadTokens: 0,
    outputTokens: 1,
    actualCostNano: '50000',
  });
  await expect(reconcileUsage(context.pool, command)).resolves.toMatchObject({
    blockedReason: null,
    replayed: true,
  });
  expect((await context.pool.query('SELECT ledger_id FROM budget_reconciliation')).rowCount).toBe(
    1,
  );
});

test.each(['manual_check', 'reservation_exceeded'] as const)(
  '核账保留 %s 安全门并拒绝覆写已完成计量',
  async (blocker) => {
    const input = await request();
    const reserved = await reserveUsage(context.pool, input);
    await markUsageIncomplete(context.pool, {
      requestKey: input.requestKey,
      runId: input.runId,
      userId: input.userId,
      reasonCode: 'missing_usage',
    });
    if (blocker === 'manual_check')
      await context.pool.query(
        "UPDATE budget_policy SET blocked_reason='manual_check' WHERE id='default'",
      );
    const command = {
      ledgerId: reserved.id,
      outcome: 'charged',
      actualCostNano: '250000000',
      inputTokens: 1000,
      cacheReadTokens: 0,
      outputTokens: 100,
      evidence: '隔离测试核对结果',
    };
    expect(await reconcileUsage(context.pool, command)).toMatchObject({
      blockedReason: blocker,
      costNano: '250000000',
    });
    await expect(
      context.pool.query('UPDATE usage_ledger SET actual_nano=1 WHERE id=$1', [reserved.id]),
    ).rejects.toMatchObject({ code: '42501' });
  },
);

test('实际费用超预占仍如实入账并冻结，不因运行已停止丢账', async () => {
  const input = await request();
  await reserveUsage(context.pool, input);
  await context.pool.query("UPDATE goal SET status='cancelled' WHERE id=$1", [context.goalId]);
  await context.pool.query(
    "UPDATE run SET status='stopped',finished_at=CURRENT_TIMESTAMP WHERE id=$1",
    [input.runId],
  );
  const result = await settleUsage(context.pool, {
    requestKey: input.requestKey,
    runId: input.runId,
    userId: input.userId,
    inputTokens: 1000,
    cacheReadTokens: 0,
    outputTokens: 100,
    actualCostNano: '250000000',
  });
  expect(result.actualNano).toBe('250000000');
  const summary = await getBudgetSummary(context.pool);
  expect(summary.nightCostNano).toBe('250000000');
  expect(summary.blockedReason).toBe('reservation_exceeded');
});

test('预占金额取Pi累计与已结算较大值，再加仍在途预占', async () => {
  const input = await request({ estimatedInputTokens: 10000, maxOutputTokens: 0 });
  await reserveUsage(context.pool, input);
  await recordCumulativeUsage(
    context.pool,
    { runId: input.runId, userId: input.userId },
    { steps: 1, totalTokens: 10, costNano: '900000000' },
  );
  await expect(
    reserveUsage(context.pool, { ...input, requestKey: randomUUID(), estimatedInputTokens: 10000 }),
  ).rejects.toMatchObject({ code: 'BUDGET_LIMIT_REACHED' });
  expect(
    (await context.pool.query('SELECT status FROM run WHERE id=$1', [input.runId])).rows[0].status,
  ).toBe('budget_exhausted');
});

test('token门禁不会让较高Pi累计吞掉另一个在途预占', async () => {
  await context.pool.query("UPDATE budget_policy SET max_tokens=60 WHERE id='default'");
  const zero = { inputUsdPerMillion: '0', cacheReadUsdPerMillion: '0', outputUsdPerMillion: '0' };
  const input = await request({ estimatedInputTokens: 10, maxOutputTokens: 0, prices: zero });
  await reserveUsage(context.pool, input);
  await settleUsage(context.pool, {
    requestKey: input.requestKey,
    runId: input.runId,
    userId: input.userId,
    inputTokens: 10,
    cacheReadTokens: 0,
    outputTokens: 0,
  });
  await reserveUsage(context.pool, {
    ...input,
    requestKey: randomUUID(),
    estimatedInputTokens: 30,
  });
  await recordCumulativeUsage(
    context.pool,
    { runId: input.runId, userId: input.userId },
    { steps: 1, totalTokens: 20, costNano: '0' },
  );
  await expect(
    reserveUsage(context.pool, { ...input, requestKey: randomUUID(), estimatedInputTokens: 20 }),
  ).rejects.toMatchObject({ code: 'BUDGET_LIMIT_REACHED' });
});

test('缓存单价较高时预占按较高单价上界，金额不会已知低估', async () => {
  const input = await request({
    estimatedInputTokens: 100,
    maxOutputTokens: 0,
    prices: { inputUsdPerMillion: '1', cacheReadUsdPerMillion: '2', outputUsdPerMillion: '0' },
  });
  expect((await reserveUsage(context.pool, input)).reservedNano).toBe('200000');
});
