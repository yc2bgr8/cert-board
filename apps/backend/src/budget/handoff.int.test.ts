import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createIntegrationContext } from '../test-support/context.js';
import * as budget from './service.js';

let context: Awaited<ReturnType<typeof createIntegrationContext>>;
const prices = { inputUsdPerMillion: '1', cacheReadUsdPerMillion: '1', outputUsdPerMillion: '1' };
async function reserve() {
  const run = await context.run();
  const input = {
    requestKey: randomUUID(),
    runId: run.runId,
    userId: run.userId,
    modelId: 'scripted/handoff',
    purpose: 'evaluation',
    estimatedInputTokens: 1,
    maxOutputTokens: 1,
    prices,
  };
  await budget.reserveUsage(context.pool, input);
  return input;
}
function usage(input: { requestKey: string; runId: string; userId: string }) {
  return {
    requestKey: input.requestKey,
    runId: input.runId,
    userId: input.userId,
    inputTokens: 1,
    cacheReadTokens: 0,
    outputTokens: 1,
    actualCostNano: '1000000',
  };
}
async function waitForBlockedQuery() {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const result = await context.pool.query(
      "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND state='active'",
    );
    if (result.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('预期的并发锁等待未出现。');
}
beforeEach(async () => {
  vi.stubEnv('CERT_TEST_SHADOW_BUDGET', '1');
  context = await createIntegrationContext();
  await budget.seedDevelopmentBudgetPolicy(context.pool, 'test');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await context?.close();
});

test('全局冻结先提交A费用，持B会话锁的事务仍能拿到B运行锁', async () => {
  const first = await reserve();
  const second = await context.run();
  const blocker = await context.pool.connect();
  let blockerOpen = false;
  let settlement: ReturnType<typeof budget.settleUsage> | undefined;
  try {
    await blocker.query('BEGIN');
    blockerOpen = true;
    await blocker.query('SELECT id FROM conversation WHERE id=$1 FOR UPDATE', [
      second.conversationId,
    ]);
    settlement = budget.settleUsage(context.pool, usage(first));
    void settlement.catch(() => undefined);
    await waitForBlockedQuery();
    const recorded = await context.pool.query<{ status: string; actual_nano: string | null }>(
      'SELECT status,actual_nano FROM usage_ledger WHERE request_key=$1',
      [first.requestKey],
    );
    await blocker.query("SET LOCAL lock_timeout='200ms'");
    const acquired = await blocker
      .query('SELECT id FROM run WHERE id=$1 FOR UPDATE', [second.runId])
      .then(
        () => true,
        () => false,
      );
    expect(acquired).toBe(true);
    expect(recorded.rows[0]).toEqual({ status: 'settled', actual_nano: '1000000' });
    await blocker.query('COMMIT');
    blockerOpen = false;
    await expect(settlement).resolves.toMatchObject({ status: 'settled', actualNano: '1000000' });
    const stopped = await context.pool.query<{ status: string }>(
      'SELECT status FROM run WHERE id=$1',
      [second.runId],
    );
    expect(stopped.rows[0]?.status).toBe('budget_exhausted');
  } finally {
    if (blockerOpen) await blocker.query('ROLLBACK');
    blocker.release();
    await settlement?.catch(() => undefined);
  }
});

test('后置交回失败仍返回已结算，保留冻结并仅记录固定安全告警，可重扫', async () => {
  const first = await reserve();
  const second = await context.run();
  await context.pool.query('UPDATE run SET budget_stop_reason=$2 WHERE id=$1', [
    second.runId,
    'handoff_fault_fixture',
  ]);
  await context.pool
    .query(`CREATE FUNCTION test_fail_handoff() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN IF OLD.budget_stop_reason='handoff_fault_fixture' AND NEW.status='budget_exhausted' THEN
      RAISE EXCEPTION 'synthetic-sensitive-handoff-detail'; END IF; RETURN NEW; END; $fn$;
    CREATE TRIGGER test_fail_handoff BEFORE UPDATE ON run FOR EACH ROW EXECUTE FUNCTION test_fail_handoff();
    CREATE FUNCTION test_fail_handoff_alert() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN IF NEW.action='budget.handoff_failed' THEN RAISE EXCEPTION 'synthetic-sensitive-audit-detail'; END IF; RETURN NEW; END; $fn$;
    CREATE TRIGGER test_fail_handoff_alert BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_fail_handoff_alert();`);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await expect(budget.settleUsage(context.pool, usage(first))).resolves.toMatchObject({
    status: 'settled',
    actualNano: '1000000',
  });
  const state = await budget.getBudgetSummary(context.pool);
  expect(state.nightCostNano).toBe('1000000');
  expect(state.blockedReason).toBe('reservation_exceeded');
  expect(warning.mock.calls).toContainEqual(['BUDGET_HANDOFF_DEFERRED']);
  expect(JSON.stringify(warning.mock.calls)).not.toContain('synthetic-sensitive');
  const next = await context.run();
  await expect(
    budget.reserveUsage(context.pool, { ...first, requestKey: randomUUID(), runId: next.runId }),
  ).rejects.toMatchObject({ code: 'BUDGET_BLOCKED' });
  await context.pool.query(
    'DROP TRIGGER test_fail_handoff_alert ON audit_log; DROP FUNCTION test_fail_handoff_alert()',
  );
  const sweep = budget.handoffBlockedBudgetRuns;
  await sweep(context.pool);
  expect(
    (
      await context.pool.query(
        "SELECT id FROM audit_log WHERE action='budget.handoff_failed' AND target_id=$1",
        [second.runId],
      )
    ).rowCount,
  ).toBeGreaterThan(0);
  await context.pool.query(
    'DROP TRIGGER test_fail_handoff ON run; DROP FUNCTION test_fail_handoff()',
  );
  await sweep(context.pool);
  expect(
    (await context.pool.query('SELECT status FROM run WHERE id=$1', [second.runId])).rows[0].status,
  ).toBe('budget_exhausted');
});

test('核账清除全局停止后，先前已取候选的扫描不得再停止新运行', async () => {
  const input = await reserve();
  const incomplete = await budget.markUsageIncomplete(context.pool, {
    requestKey: input.requestKey,
    runId: input.runId,
    userId: input.userId,
    reasonCode: 'timeout',
  });
  const candidate = await context.run();
  let selected!: () => void;
  let resume!: () => void;
  const candidatesRead = new Promise<void>((resolve) => {
    selected = resolve;
  });
  const proceed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const query = context.pool.query.bind(context.pool);
  vi.spyOn(context.pool, 'query').mockImplementation(((text: string, values?: unknown[]) => {
    const result = query(text, values);
    if (!text.startsWith('SELECT id,user_id FROM run WHERE status')) return result;
    return result.then(async (rows) => {
      selected();
      await proceed;
      return rows;
    });
  }) as typeof context.pool.query);
  const sweep = budget.handoffBlockedBudgetRuns(context.pool);
  try {
    await candidatesRead;
    await expect(
      budget.reconcileUsage(context.pool, {
        ledgerId: incomplete.id,
        outcome: 'not_sent',
        evidence: '隔离测试未发出',
      }),
    ).resolves.toMatchObject({ blockedReason: null });
    resume();
    await expect(sweep).resolves.toMatchObject({ stopped: 0, failed: 0 });
    expect(
      (await query('SELECT status FROM run WHERE id=$1', [candidate.runId])).rows[0]?.status,
    ).toBe('running');
  } finally {
    resume();
    await sweep;
  }
});
