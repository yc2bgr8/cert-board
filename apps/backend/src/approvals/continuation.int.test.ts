import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { createIntegrationContext } from '../test-support/context.js';
import { createToolRuntime } from '../agent/tool-runtime.js';
import { releaseRunLease } from '../runs/lease.js';
import { ToolRegistry, type ToolDefinition, type ToolExecutionContext } from '../tools/registry.js';
import { AppError } from '../api/errors.js';
import { seedDevelopmentBudgetPolicy, reserveUsage } from '../budget/service.js';
import {
  getContinuationTicket,
  prepareContinuationForDispatch,
  claimContinuationForLease,
  markContinuationModelStarted,
  finishContinuation,
  readContinuationResult,
  listContinuationsForDispatch,
} from './continuation.js';

type Context = Awaited<ReturnType<typeof createIntegrationContext>>;
let context: Context;
let auth: Awaited<ReturnType<Context['login']>>;
const cleanups: Array<() => Promise<unknown>> = [];
const inputSchema = z
  .object({ value: z.string().max(1000), expectedVersion: z.number().int().positive() })
  .strict();
type Input = z.infer<typeof inputSchema>;
async function record() {
  return (
    await context.pool.query<{ next_action: string | null; version: number }>(
      'SELECT next_action,version FROM cert_project WHERE id=$1',
      [context.projectId],
    )
  ).rows[0]!;
}
function definition(version = '1') {
  const execute = vi.fn(async (ctx: ToolExecutionContext, input: Input) => {
    const changed = (
      await ctx.tx.query<{ version: number }>(
        'UPDATE cert_project SET next_action=$1,version=version+1 WHERE id=$2 AND version=$3 RETURNING version',
        [input.value, ctx.projectId, input.expectedVersion],
      )
    ).rows[0];
    if (!changed) throw new AppError(409, 'FIXTURE_VERSION_CHANGED', '原版本变化');
    return {
      data: { version: changed.version },
      dataLevel: 'internal' as const,
      afterVersion: changed.version,
    };
  });
  const capture = vi.fn(async (ctx: ToolExecutionContext) => {
    const current = (
      await ctx.tx.query<{ next_action: string | null; version: number }>(
        'SELECT next_action,version FROM cert_project WHERE id=$1 FOR UPDATE',
        [ctx.projectId],
      )
    ).rows[0]!;
    return {
      targetType: 'cert_project',
      targetId: ctx.projectId!,
      beforeState: { nextAction: current.next_action },
      beforeVersion: current.version,
    };
  });
  const prepareApproval = vi.fn(async (ctx: ToolExecutionContext, input: Input) => {
    const current = (
      await ctx.tx.query<{ next_action: string | null; version: number }>(
        'SELECT next_action,version FROM cert_project WHERE id=$1 FOR SHARE',
        [ctx.projectId],
      )
    ).rows[0]!;
    if (current.version !== input.expectedVersion)
      throw new AppError(409, 'FIXTURE_VERSION_CHANGED', '原版本变化');
    return {
      summary: '修改项目下一步',
      changes: [
        {
          recordType: 'cert_project',
          recordId: ctx.projectId!,
          field: 'nextAction',
          before: current.next_action,
          after: input.value,
        },
      ],
      targetVersions: [
        { targetType: 'cert_project', targetId: ctx.projectId!, version: String(current.version) },
      ],
      dataLevel: 'internal' as const,
    };
  });
  const tool: ToolDefinition<Input, { version: number }> = {
    metadata: {
      name: 'resume_test_write',
      version,
      publication: 'published',
      effect: 'reversible_write',
      approvalInAsk: true,
      modes: ['ask', 'full'],
      outputDataLevel: 'internal',
      authorizationAction: 'record.write',
      description: {
        purpose: '继续测试记录写入。',
        whenToUse: '仅测试批准恢复。',
        avoid: '不能审批或用于生产。',
        parameters: 'value与expectedVersion。',
        example: { value: '待核对', expectedVersion: 1 },
      },
    },
    inputSchema,
    outputSchema: z.object({ version: z.number().int().positive() }).strict(),
    execute,
    prepareApproval,
    undo: {
      beforeSchema: z.object({ nextAction: z.string().nullable() }).strict(),
      capture,
      async currentVersion(ctx, target) {
        return (
          (
            await ctx.tx.query<{ version: number }>(
              'SELECT version FROM cert_project WHERE id=$1',
              [target.targetId],
            )
          ).rows[0]?.version ?? null
        );
      },
      async apply(ctx, undo) {
        const before = z.object({ nextAction: z.string().nullable() }).parse(undo.beforeState);
        const row = (
          await ctx.tx.query<{ version: number }>(
            'UPDATE cert_project SET next_action=$1,version=version+1 WHERE id=$2 AND version=$3 RETURNING version',
            [before.nextAction, undo.targetId, Number(undo.afterVersion)],
          )
        ).rows[0];
        if (!row) throw new AppError(409, 'FIXTURE_VERSION_CHANGED', '版本变化');
        return { afterVersion: row.version };
      },
    },
  };
  return { tool, execute, capture, prepareApproval };
}
async function authority(
  runId: string,
  userId: string,
  tool: ToolDefinition,
  signal = new AbortController().signal,
) {
  const runtime = await createToolRuntime({
    pool: context.pool,
    definitions: [tool],
    runId,
    userId,
    ownerId: randomUUID(),
    signal,
    environment: 'test',
  });
  const identity = {
    runId,
    userId,
    ownerId: runtime.lease.ownerId,
    generation: runtime.lease.generation,
  };
  cleanups.push(async () => {
    const held = (
      await context.pool.query<{ lease_owner: string | null; lease_generation: string }>(
        'SELECT lease_owner,lease_generation FROM run WHERE id=$1',
        [runId],
      )
    ).rows[0];
    if (
      held?.lease_owner === identity.ownerId &&
      Number(held.lease_generation) === identity.generation
    )
      await releaseRunLease(context.pool, identity);
  });
  return { ...runtime, identity };
}
async function decided(
  action: 'allow_once' | 'allow_conversation' | 'reject' = 'allow_once',
  release = true,
  pendingUsage = false,
  trigger: 'conversation' | 'evaluation' = 'conversation',
) {
  const source =
    trigger === 'conversation'
      ? await context.run()
      : await (async () => {
          const userId = context.userId('MEMBER_A');
          const conversationId = (
            await context.pool.query<{ id: string }>(
              "INSERT INTO conversation(project_id,goal_id,user_id,title,permission_mode,agent_code) VALUES($1,$2,$3,'显式评测续跑','ask','registration') RETURNING id",
              [context.projectId, context.goalId, userId],
            )
          ).rows[0]!.id;
          const runId = (
            await context.pool.query<{ id: string }>(
              "INSERT INTO run(project_id,goal_id,user_id,conversation_id,status,trigger_type) VALUES($1,$2,$3,$4,'running','evaluation') RETURNING id",
              [context.projectId, context.goalId, userId, conversationId],
            )
          ).rows[0]!.id;
          return { runId, conversationId, userId, callId: randomUUID() };
        })();
  const reference = { runId: source.runId, userId: source.userId, callId: source.callId };
  const tool = definition();
  const initial = await authority(source.runId, source.userId, tool.tool);
  const before = await record();
  const input = { value: `PRIVATE_RESUME_VALUE_${randomUUID()}`, expectedVersion: before.version };
  const pending = await initial.registry.execute(reference, tool.tool.metadata.name, input);
  const approvalId = z.object({ approvalId: z.uuid() }).parse(pending.data).approvalId;
  if (pendingUsage) {
    await seedDevelopmentBudgetPolicy(context.pool, 'test');
    await reserveUsage(context.pool, {
      requestKey: randomUUID(),
      runId: source.runId,
      userId: source.userId,
      modelId: 'scripted/continuation-test',
      purpose: 'evaluation',
      estimatedInputTokens: 1,
      maxOutputTokens: 1,
      prices: { inputUsdPerMillion: '1', outputUsdPerMillion: '1', cacheReadUsdPerMillion: '1' },
    });
  }
  await context.pool.query(
    "UPDATE run SET status='waiting',finished_at=clock_timestamp() WHERE id=$1",
    [source.runId],
  );
  if (release) await releaseRunLease(context.pool, initial.identity);
  const card = (
    await context.pool.query('SELECT version,content_hash FROM tool_approval WHERE id=$1', [
      approvalId,
    ])
  ).rows[0];
  const payload = {
    requestKey: randomUUID(),
    expectedVersion: card.version,
    expectedContentHash: card.content_hash,
    action,
    ...(action === 'reject' ? { reason: 'PRIVATE_REJECTION_REASON_请先核对原件' } : {}),
  };
  const response = await context.app.inject({
    method: 'POST',
    url: `/api/approvals/${approvalId}`,
    headers: auth.headers,
    payload,
  });
  expect(response.statusCode).toBe(200);
  const ticketId = z.string().uuid().parse(response.json().continuationId);
  return {
    source,
    reference,
    tool,
    initial,
    before,
    input,
    approvalId,
    payload,
    ticketId,
    pending,
  };
}
async function resumeAuthority(item: Awaited<ReturnType<typeof decided>>, tool = item.tool.tool) {
  expect((await prepareContinuationForDispatch(context.pool, item.ticketId))?.state).toBe('queued');
  const active = await authority(item.source.runId, item.source.userId, tool);
  const lease = { ...active.identity, ticketId: item.ticketId };
  expect((await claimContinuationForLease(context.pool, lease)).state).toBe('claimed');
  return { ...active, continuationLease: lease };
}
beforeAll(async () => {
  context = await createIntegrationContext();
  auth = await context.login();
});
afterEach(async () => {
  for (const dispose of cleanups.splice(0)) await dispose();
});
afterAll(async () => {
  await context?.close();
});

test('同run真实租约继续原调用一次：参数、旧批准、预算保留，回执和事件原子幂等', async () => {
  const item = await decided();
  const original = (
    await context.pool.query(
      'SELECT arguments_json,preview_json,content_hash,status FROM tool_approval WHERE id=$1',
      [item.approvalId],
    )
  ).rows[0];
  await context.pool.query(
    'UPDATE run SET budget_steps=3,budget_total_tokens=100,budget_cost_nano=50 WHERE id=$1',
    [item.source.runId],
  );
  const active = await resumeAuthority(item);
  expect(active.lease.generation).toBe(item.initial.lease.generation + 1);
  expect(
    (await active.registry.execute(item.reference, item.tool.tool.metadata.name, item.input))
      .status,
  ).toBe('pending_approval');
  const done = await active.registry.resumeApproval(item.reference, item.ticketId);
  expect(done).toMatchObject({
    invocationId: item.pending.invocationId,
    status: 'completed',
    replayed: false,
  });
  expect(item.tool.execute).toHaveBeenCalledTimes(1);
  expect(item.tool.capture).toHaveBeenCalledTimes(1);
  expect((await record()).next_action).toBe(item.input.value);
  expect(await active.registry.resumeApproval(item.reference, item.ticketId)).toMatchObject({
    invocationId: done.invocationId,
    replayed: true,
  });
  expect(item.tool.execute).toHaveBeenCalledTimes(1);
  expect((await getContinuationTicket(context.pool, item.ticketId))?.state).toBe('tool_recorded');
  expect(
    (
      await context.pool.query(
        'SELECT arguments_json,preview_json,content_hash,status FROM tool_approval WHERE id=$1',
        [item.approvalId],
      )
    ).rows[0],
  ).toEqual(original);
  expect(
    (
      await context.pool.query(
        'SELECT budget_steps,budget_total_tokens,budget_cost_nano FROM run WHERE id=$1',
        [item.source.runId],
      )
    ).rows[0],
  ).toEqual({ budget_steps: '3', budget_total_tokens: '100', budget_cost_nano: '50' });
  expect(
    (
      await context.pool.query(
        "SELECT count(*)::int AS n FROM conversation_event WHERE run_id=$1 AND type='approval_resolved'",
        [item.source.runId],
      )
    ).rows[0].n,
  ).toBe(1);
  const projected = await readContinuationResult(
    context.pool,
    item.ticketId,
    item.source.runId,
    item.source.userId,
  );
  expect(projected).toMatchObject({ callId: item.source.callId, result: { data: done.data } });
  expect(projected).not.toHaveProperty('argumentsJson');
  expect(projected).not.toHaveProperty('arguments_json');
});

test('API重复允许只安排一个继续票据，原lease仍占用时不投递', async () => {
  const item = await decided('allow_once', false);
  const repeated = await context.app.inject({
    method: 'POST',
    url: `/api/approvals/${item.approvalId}`,
    headers: auth.headers,
    payload: item.payload,
  });
  expect(repeated.statusCode).toBe(200);
  expect(repeated.json()).toMatchObject({
    continuationId: item.ticketId,
    replayed: true,
    executed: false,
  });
  expect(await prepareContinuationForDispatch(context.pool, item.ticketId)).toBeNull();
  expect(
    (
      await context.pool.query(
        'SELECT count(*)::int AS n FROM run_continuation WHERE approval_id=$1',
        [item.approvalId],
      )
    ).rows[0].n,
  ).toBe(1);
  await releaseRunLease(context.pool, item.initial.identity);
  expect((await prepareContinuationForDispatch(context.pool, item.ticketId))?.state).toBe('queued');
});

test('拒绝恢复只记录私有原因，不捕获撤销原值、不执行，也不修改业务值', async () => {
  const item = await decided('reject');
  const active = await resumeAuthority(item);
  const result = await active.registry.resumeApproval(item.reference, item.ticketId);
  expect(result).toMatchObject({
    status: 'approval_rejected',
    data: { executed: false, rejected: true, reason: item.payload.reason },
  });
  expect(item.tool.execute).not.toHaveBeenCalled();
  expect(item.tool.capture).not.toHaveBeenCalled();
  expect(await record()).toEqual(item.before);
  expect(
    JSON.stringify(
      (
        await context.pool.query('SELECT * FROM audit_log WHERE target_id IN ($1,$2)', [
          item.approvalId,
          item.pending.invocationId,
        ])
      ).rows,
    ),
  ).not.toContain(item.payload.reason);
  expect(
    (
      await context.pool.query('SELECT status FROM tool_invocation WHERE id=$1', [
        item.pending.invocationId,
      ])
    ).rows[0].status,
  ).toBe('denied');
});

test('批准后对象版本或工具版本变化时保存失效回执而不执行', async () => {
  const changed = await decided();
  await context.pool.query(
    "UPDATE cert_project SET next_action='人工后续改动',version=version+1 WHERE id=$1",
    [context.projectId],
  );
  const active = await resumeAuthority(changed);
  expect(await active.registry.resumeApproval(changed.reference, changed.ticketId)).toMatchObject({
    status: 'approval_stale',
    data: { executed: false },
  });
  expect(changed.tool.execute).not.toHaveBeenCalled();
  expect((await record()).next_action).toBe('人工后续改动');
  const obsolete = await decided();
  const nextTool = definition('2');
  const current = await resumeAuthority(obsolete, nextTool.tool);
  expect(
    await current.registry.resumeApproval(obsolete.reference, obsolete.ticketId),
  ).toMatchObject({ status: 'approval_stale' });
  expect(nextTool.prepareApproval).not.toHaveBeenCalled();
  expect(nextTool.execute).not.toHaveBeenCalled();
});

test('切为只读后不能消费已批准调用，旧执行代次和无guard登记器也被拒绝', async () => {
  const item = await decided();
  const active = await resumeAuthority(item);
  await expect(
    item.initial.registry.resumeApproval(item.reference, item.ticketId),
  ).rejects.toMatchObject({ code: 'TOOL_RUNTIME_INACTIVE' });
  await expect(
    new ToolRegistry(context.pool, [item.tool.tool], { environment: 'test' }).resumeApproval(
      item.reference,
      item.ticketId,
    ),
  ).rejects.toMatchObject({ code: 'CONTINUATION_RUNTIME_REQUIRED' });
  await context.pool.query("UPDATE conversation SET permission_mode='read_only' WHERE id=$1", [
    item.source.conversationId,
  ]);
  expect(await active.registry.resumeApproval(item.reference, item.ticketId)).toMatchObject({
    status: 'approval_stale',
    data: { executed: false },
  });
  expect(item.tool.execute).not.toHaveBeenCalled();
});

test('模型开始标记封闭再次工具恢复，终态不能倒回待投递', async () => {
  const item = await decided();
  const active = await resumeAuthority(item);
  await active.registry.resumeApproval(item.reference, item.ticketId);
  expect((await markContinuationModelStarted(context.pool, active.continuationLease)).state).toBe(
    'model_started',
  );
  await expect(active.registry.resumeApproval(item.reference, item.ticketId)).rejects.toMatchObject(
    { code: 'CONTINUATION_UNAVAILABLE' },
  );
  expect(await prepareContinuationForDispatch(context.pool, item.ticketId)).toBeNull();
  expect(
    (await listContinuationsForDispatch(context.pool)).some(
      (ticket) => ticket.id === item.ticketId,
    ),
  ).toBe(false);
  expect(
    (
      await finishContinuation(context.pool, active.continuationLease, {
        state: 'blocked',
        reasonCode: 'MODEL_RESULT_UNCERTAIN',
      })
    ).state,
  ).toBe('blocked');
  expect(
    await readContinuationResult(
      context.pool,
      item.ticketId,
      item.source.runId,
      item.source.userId,
    ),
  ).not.toBeNull();
  await expect(
    context.pool.query("UPDATE run_continuation SET state='queued',version=version+1 WHERE id=$1", [
      item.ticketId,
    ]),
  ).rejects.toMatchObject({ code: '42501' });
});

test('两个相同继续执行请求串行返回同一结果，事件与效果只保存一次', async () => {
  const item = await decided();
  const active = await resumeAuthority(item);
  const results = await Promise.all([
    active.registry.resumeApproval(item.reference, item.ticketId),
    active.registry.resumeApproval(item.reference, item.ticketId),
  ]);
  expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
  expect(item.tool.execute).toHaveBeenCalledTimes(1);
  expect(
    (
      await context.pool.query(
        'SELECT count(*)::int AS n FROM conversation_tool_result WHERE invocation_id=$1',
        [item.pending.invocationId],
      )
    ).rows[0].n,
  ).toBe(1);
  await expect(
    context.pool.query('DELETE FROM run_continuation WHERE id=$1', [item.ticketId]),
  ).rejects.toMatchObject({ code: '42501' });
});

test('原run费用尚未结算时票据被阻断，不能排队或重发模型', async () => {
  const item = await decided('allow_once', true, true);
  expect(await prepareContinuationForDispatch(context.pool, item.ticketId)).toBeNull();
  expect((await getContinuationTicket(context.pool, item.ticketId))?.state).toBe('blocked');
  expect(
    (
      await context.pool.query('SELECT reason_code FROM run_continuation WHERE id=$1', [
        item.ticketId,
      ])
    ).rows[0].reason_code,
  ).toBe('CONTINUATION_USAGE_UNCERTAIN');
  expect(item.tool.execute).not.toHaveBeenCalled();
});

test('回执事件写入失败时业务、undo和真实工具结果一起回滚，旧批准仍完整', async () => {
  const item = await decided();
  const active = await resumeAuthority(item);
  await context.pool
    .query(`CREATE FUNCTION reject_test_continuation_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.type='approval_resolved' THEN RAISE EXCEPTION 'PRIVATE_EVENT_FAILURE'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER reject_test_continuation BEFORE INSERT ON conversation_event FOR EACH ROW EXECUTE FUNCTION reject_test_continuation_event();`);
  try {
    await expect(
      active.registry.resumeApproval(item.reference, item.ticketId),
    ).rejects.toMatchObject({ code: 'TOOL_TRANSACTION_FAILED' });
    expect(await record()).toEqual(item.before);
    expect(
      (
        await context.pool.query(
          'SELECT count(*)::int AS n FROM undo_record WHERE invocation_id=$1',
          [item.pending.invocationId],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await context.pool.query(
          'SELECT count(*)::int AS n FROM conversation_tool_result WHERE invocation_id=$1',
          [item.pending.invocationId],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await context.pool.query('SELECT status FROM tool_invocation WHERE id=$1', [
          item.pending.invocationId,
        ])
      ).rows[0].status,
    ).toBe('pending_approval');
    expect((await getContinuationTicket(context.pool, item.ticketId))?.state).toBe('claimed');
  } finally {
    await context.pool.query('DROP TRIGGER reject_test_continuation ON conversation_event');
  }
  expect((await active.registry.resumeApproval(item.reference, item.ticketId)).status).toBe(
    'completed',
  );
  expect((await record()).version).toBe(item.before.version + 1);
});

test('真实执行意外升密会撤销业务效果并保留升密的失效回执', async () => {
  const item = await decided();
  const elevated: typeof item.tool.tool = {
    ...item.tool.tool,
    async execute(ctx, input, before) {
      const result = await item.tool.tool.execute!(ctx, input, before);
      return { ...result, dataLevel: 'confidential' };
    },
  };
  const active = await resumeAuthority(item, elevated);
  const result = await active.registry.resumeApproval(item.reference, item.ticketId);
  expect(result).toMatchObject({
    status: 'approval_stale',
    dataLevel: 'confidential',
    data: { executed: false },
  });
  expect(await record()).toEqual(item.before);
  expect(
    (await context.pool.query('SELECT max_data_level FROM run WHERE id=$1', [item.source.runId]))
      .rows[0].max_data_level,
  ).toBe('confidential');
  expect(
    (
      await context.pool.query(
        'SELECT count(*)::int AS n FROM undo_record WHERE invocation_id=$1',
        [item.pending.invocationId],
      )
    ).rows[0].n,
  ).toBe(0);
});

test('后台派发不领取evaluation续跑，显式评测准备仍可使用同一安全路径', async () => {
  const item = await decided('allow_once', true, false, 'evaluation');
  expect(
    (await listContinuationsForDispatch(context.pool)).some(
      (ticket) => ticket.id === item.ticketId,
    ),
  ).toBe(false);
  expect((await getContinuationTicket(context.pool, item.ticketId))?.state).toBe('pending');
  expect((await prepareContinuationForDispatch(context.pool, item.ticketId))?.state).toBe('queued');
  expect(
    (await listContinuationsForDispatch(context.pool)).some(
      (ticket) => ticket.id === item.ticketId,
    ),
  ).toBe(false);
});
