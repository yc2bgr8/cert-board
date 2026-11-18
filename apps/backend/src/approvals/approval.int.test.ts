import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { DataLevel, ToolApprovalPreview } from '@cert-board/shared';
import { createIntegrationContext } from '../test-support/context.js';
import { ToolRegistry, type ToolDefinition, type ToolExecutionContext } from '../tools/registry.js';
import { AppError } from '../api/errors.js';
import { createToolRuntime } from '../agent/tool-runtime.js';
import { releaseRunLease } from '../runs/lease.js';

type Context = Awaited<ReturnType<typeof createIntegrationContext>>;
type Login = Awaited<ReturnType<Context['login']>>;
let context: Context;
let owner: Login;
let other: Login;
let admin: Login;
const inputSchema = z
  .object({ value: z.string().min(1).max(2000), expectedVersion: z.number().int().positive() })
  .strict();
type Input = z.infer<typeof inputSchema>;
const outputSchema = z.object({ version: z.number().int().positive() }).strict();
async function project() {
  return (
    await context.pool.query<{ next_action: string | null; version: number }>(
      'SELECT next_action,version FROM cert_project WHERE id=$1',
      [context.projectId],
    )
  ).rows[0]!;
}
function writer(
  options: { name?: string; version?: string; level?: DataLevel; failPreview?: boolean } = {},
) {
  const execute = vi.fn(async (ctx: ToolExecutionContext, input: Input) => {
    const changed = await ctx.tx.query<{ version: number }>(
      'UPDATE cert_project SET next_action=$1,version=version+1 WHERE id=$2 AND version=$3 RETURNING version',
      [input.value, ctx.projectId, input.expectedVersion],
    );
    if (!changed.rows[0]) throw new AppError(409, 'VERSION_CONFLICT', '目标版本已变化');
    return {
      data: { version: changed.rows[0].version },
      dataLevel: options.level ?? 'internal',
      afterVersion: changed.rows[0].version,
    };
  });
  const capture = vi.fn(async (ctx: ToolExecutionContext) => {
    const record = (
      await ctx.tx.query<{ next_action: string | null; version: number }>(
        'SELECT next_action,version FROM cert_project WHERE id=$1 FOR UPDATE',
        [ctx.projectId],
      )
    ).rows[0]!;
    return {
      targetType: 'cert_project',
      targetId: ctx.projectId!,
      beforeState: { nextAction: record.next_action },
      beforeVersion: record.version,
    };
  });
  const prepareApproval = vi.fn(
    async (ctx: ToolExecutionContext, input: Input): Promise<ToolApprovalPreview> => {
      if (options.failPreview) throw new Error('PRIVATE_PREVIEW_EXCEPTION');
      const record = (
        await ctx.tx.query<{ next_action: string | null; version: number }>(
          'SELECT next_action,version FROM cert_project WHERE id=$1 FOR SHARE',
          [ctx.projectId],
        )
      ).rows[0]!;
      if (record.version !== input.expectedVersion)
        throw new AppError(409, 'VERSION_CONFLICT', '目标版本已变化');
      return {
        summary: '更新项目下一步记录',
        changes: [
          {
            recordType: 'cert_project',
            recordId: ctx.projectId!,
            field: 'nextAction',
            before: record.next_action,
            after: input.value,
          },
        ],
        targetVersions: [
          { targetType: 'cert_project', targetId: ctx.projectId!, version: String(record.version) },
        ],
        dataLevel: options.level ?? 'internal',
      };
    },
  );
  const definition: ToolDefinition<Input, z.infer<typeof outputSchema>> = {
    metadata: {
      name: options.name ?? 'approval_test_write',
      version: options.version ?? '1',
      publication: 'published',
      effect: 'reversible_write',
      modes: ['read_only', 'ask', 'full'],
      approvalInAsk: true,
      outputDataLevel: 'internal',
      authorizationAction: 'record.write',
      description: {
        purpose: '更新受控测试项目记录。',
        whenToUse: '测试过程批准时。',
        avoid: '不能用于审批或生产。',
        parameters: 'value是新值，expectedVersion是已读版本。',
        example: { value: '待核对', expectedVersion: 1 },
      },
    },
    inputSchema,
    outputSchema,
    execute,
    prepareApproval,
    undo: {
      beforeSchema: z.object({ nextAction: z.string().nullable() }).strict(),
      capture,
      async currentVersion(ctx, record) {
        return (
          (
            await ctx.tx.query<{ version: number }>(
              'SELECT version FROM cert_project WHERE id=$1',
              [record.targetId],
            )
          ).rows[0]?.version ?? null
        );
      },
      async apply(ctx, record) {
        const original = z.object({ nextAction: z.string().nullable() }).parse(record.beforeState);
        const row = (
          await ctx.tx.query<{ version: number }>(
            'UPDATE cert_project SET next_action=$1,version=version+1 WHERE id=$2 AND version=$3 RETURNING version',
            [original.nextAction, record.targetId, Number(record.afterVersion)],
          )
        ).rows[0];
        if (!row) throw new AppError(409, 'VERSION_CONFLICT', '撤销版本已变化');
        return { afterVersion: row.version };
      },
    },
  };
  return { definition, execute, capture, prepareApproval };
}
async function pending(options: Parameters<typeof writer>[0] = {}) {
  const { conversationId, ...reference } = await context.run();
  const tool = writer(options);
  const registry = new ToolRegistry(context.pool, [tool.definition], { environment: 'test' });
  const input = {
    value: `PRIVATE_APPROVAL_BODY_${randomUUID()}`,
    expectedVersion: (await project()).version,
  };
  const result = await registry.execute(reference, tool.definition.metadata.name, input);
  const approvalId = z.object({ approvalId: z.uuid() }).parse(result.data).approvalId;
  return { reference, conversationId, tool, registry, input, result, approvalId };
}
async function decisionInput(
  approvalId: string,
  action: 'allow_once' | 'allow_conversation' | 'reject' = 'allow_once',
) {
  const row = (
    await context.pool.query<{ version: number; content_hash: string }>(
      'SELECT version,content_hash FROM tool_approval WHERE id=$1',
      [approvalId],
    )
  ).rows[0]!;
  return {
    requestKey: randomUUID(),
    expectedVersion: row.version,
    expectedContentHash: row.content_hash,
    action,
  };
}
async function decide(
  approvalId: string,
  payload: Awaited<ReturnType<typeof decisionInput>> & { reason?: string },
  login = owner,
) {
  return context.app.inject({
    method: 'POST',
    url: `/api/approvals/${approvalId}`,
    headers: login.headers,
    payload,
  });
}
beforeAll(async () => {
  context = await createIntegrationContext();
  [owner, other, admin] = await Promise.all([
    context.login(),
    context.login('MEMBER_B'),
    context.login('ADMIN'),
  ]);
});
afterAll(async () => {
  if (context) await context.close();
});

test('ask保存可信前后值与私有参数，重复调用同一请求且不执行写入或撤销回调', async () => {
  const original = await project();
  const request = await pending();
  const repeated = await request.registry.execute(
    request.reference,
    request.tool.definition.metadata.name,
    request.input,
  );
  expect(request.result.status).toBe('pending_approval');
  expect(repeated).toMatchObject({
    invocationId: request.result.invocationId,
    replayed: true,
    status: 'pending_approval',
    data: { approvalId: request.approvalId },
  });
  expect(request.tool.prepareApproval).toHaveBeenCalledTimes(1);
  expect(request.tool.execute).not.toHaveBeenCalled();
  expect(request.tool.capture).not.toHaveBeenCalled();
  expect(await project()).toEqual(original);
  const row = (
    await context.pool.query('SELECT * FROM tool_approval WHERE id=$1', [request.approvalId])
  ).rows[0];
  expect(row.arguments_json).toEqual(request.input);
  expect(row.preview_json.changes[0]).toMatchObject({
    before: original.next_action,
    after: request.input.value,
  });
  expect(
    (
      await context.pool.query(
        'SELECT count(*)::int AS count FROM undo_record WHERE invocation_id=$1',
        [request.result.invocationId],
      )
    ).rows[0].count,
  ).toBe(0);
  expect(
    (await context.pool.query('SELECT status FROM run WHERE id=$1', [request.reference.runId]))
      .rows[0].status,
  ).toBe('running');
  const metadata = await context.pool.query(
    'SELECT to_jsonb(i) AS item FROM tool_invocation i WHERE id=$1',
    [request.result.invocationId],
  );
  const audits = await context.pool.query(
    'SELECT to_jsonb(a) AS item FROM audit_log a WHERE target_id=$1',
    [request.approvalId],
  );
  expect(JSON.stringify([metadata.rows, audits.rows])).not.toContain(request.input.value);
  await expect(
    request.registry.execute(request.reference, request.tool.definition.metadata.name, {
      ...request.input,
      value: '变参',
    }),
  ).rejects.toMatchObject({ code: 'TOOL_IDEMPOTENCY_CONFLICT' });
});

test('待批准元数据重复并发只建立一个请求，预览异常不会遗留半张卡', async () => {
  const { conversationId: _conversation, ...reference } = await context.run();
  const tool = writer();
  const registry = new ToolRegistry(context.pool, [tool.definition], { environment: 'test' });
  const input = { value: '并发受控预览', expectedVersion: (await project()).version };
  const results = await Promise.all([
    registry.execute(reference, tool.definition.metadata.name, input),
    registry.execute(reference, tool.definition.metadata.name, input),
  ]);
  expect(results[0]?.invocationId).toBe(results[1]?.invocationId);
  expect(tool.prepareApproval).toHaveBeenCalledTimes(1);
  const broken = writer({ failPreview: true });
  const failureId = randomUUID();
  await expect(
    new ToolRegistry(context.pool, [broken.definition], { environment: 'test' }).execute(
      { ...reference, callId: failureId },
      broken.definition.metadata.name,
      input,
    ),
  ).rejects.toMatchObject({ code: 'TOOL_EXECUTION_FAILED' });
  expect(
    (
      await context.pool.query(
        'SELECT count(*)::int AS count FROM tool_invocation WHERE run_id=$1 AND call_id=$2',
        [reference.runId, failureId],
      )
    ).rows[0].count,
  ).toBe(0);
  expect(broken.execute).not.toHaveBeenCalled();
});

test('批准卡仅本人能查看处理，管理员也不能代批；只返回预览不返回参数', async () => {
  const request = await pending();
  for (const login of [other, admin]) {
    expect(
      (
        await context.app.inject({
          method: 'GET',
          url: `/api/approvals/${request.approvalId}`,
          headers: login.headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await decide(request.approvalId, await decisionInput(request.approvalId), login)).statusCode,
    ).toBe(404);
  }
  const response = await context.app.inject({
    method: 'GET',
    url: `/api/approvals/${request.approvalId}`,
    headers: owner.headers,
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json().preview.changes[0].after).toBe(request.input.value);
  expect(response.json()).not.toHaveProperty('argumentsJson');
  expect(response.json()).not.toHaveProperty('arguments_json');
});

test('浏览器决定必须同时有Cookie、同源与CSRF，不接受后台伪造或额外参数', async () => {
  const request = await pending();
  const payload = await decisionInput(request.approvalId);
  const attempts = [
    { headers: { cookie: owner.cookie }, expected: 403 },
    { headers: { ...owner.headers, origin: 'https://example.invalid' }, expected: 403 },
    {
      headers: {
        'x-user-id': request.reference.userId,
        'x-csrf-token': owner.csrfToken,
        origin: context.config.WEB_ORIGIN,
        'sec-fetch-site': 'same-origin',
      },
      expected: 401,
    },
  ];
  for (const attempt of attempts)
    expect(
      (
        await context.app.inject({
          method: 'POST',
          url: `/api/approvals/${request.approvalId}`,
          headers: attempt.headers,
          payload,
        })
      ).statusCode,
    ).toBe(attempt.expected);
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url: `/api/approvals/${request.approvalId}`,
        headers: owner.headers,
        payload: { ...payload, arguments: { value: '偷偷替换' } },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (await context.pool.query('SELECT status FROM tool_approval WHERE id=$1', [request.approvalId]))
      .rows[0].status,
  ).toBe('pending');
  expect(request.tool.execute).not.toHaveBeenCalled();
});

test('允许只记录决定，不执行当前调用；同请求幂等，变更决定和重复批准被拒', async () => {
  const request = await pending();
  const original = await project();
  const payload = await decisionInput(request.approvalId);
  const response = await decide(request.approvalId, payload);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    status: 'approved',
    version: 2,
    replayed: false,
    executed: false,
  });
  const repeated = await decide(request.approvalId, payload);
  expect(repeated.statusCode).toBe(200);
  expect(repeated.json()).toMatchObject({
    decisionId: response.json().decisionId,
    replayed: true,
    executed: false,
  });
  expect(
    (await decide(request.approvalId, { ...payload, action: 'allow_conversation' })).statusCode,
  ).toBe(409);
  expect(
    (await decide(request.approvalId, { ...payload, requestKey: randomUUID() })).statusCode,
  ).toBe(409);
  expect(await project()).toEqual(original);
  const replay = await request.registry.execute(
    request.reference,
    request.tool.definition.metadata.name,
    request.input,
  );
  expect(replay).toMatchObject({ status: 'pending_approval', data: { status: 'approved' } });
  expect(request.tool.execute).not.toHaveBeenCalled();
  expect(
    (
      await context.pool.query(
        'SELECT count(*)::int AS count FROM conversation_tool_grant WHERE conversation_id=$1',
        [request.conversationId],
      )
    ).rows[0].count,
  ).toBe(0);
});

test('拒绝原因只存私有决定，旧调用回放拒绝状态而不重试', async () => {
  const request = await pending();
  const reason = 'PRIVATE_REJECTION_请补充原始资料';
  const response = await decide(request.approvalId, {
    ...(await decisionInput(request.approvalId, 'reject')),
    reason,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: 'rejected', executed: false });
  const row = (
    await context.pool.query('SELECT reason FROM tool_approval_decision WHERE approval_id=$1', [
      request.approvalId,
    ])
  ).rows[0];
  expect(row.reason).toBe(reason);
  expect(
    JSON.stringify(
      (await context.pool.query('SELECT * FROM audit_log WHERE target_id=$1', [request.approvalId]))
        .rows,
    ),
  ).not.toContain(reason);
  expect(
    await request.registry.execute(
      request.reference,
      request.tool.definition.metadata.name,
      request.input,
    ),
  ).toMatchObject({ data: { status: 'rejected' }, replayed: true });
  expect(request.tool.execute).not.toHaveBeenCalled();
});

test('同会话同工具版本授权仅免以后询问，不执行旧调用，不扩到其他会话或版本且只读优先', async () => {
  const request = await pending();
  expect(
    (
      await decide(
        request.approvalId,
        await decisionInput(request.approvalId, 'allow_conversation'),
      )
    ).statusCode,
  ).toBe(200);
  await request.registry.execute(
    request.reference,
    request.tool.definition.metadata.name,
    request.input,
  );
  expect(request.tool.execute).not.toHaveBeenCalled();
  const performed = await request.registry.execute(
    { ...request.reference, callId: randomUUID() },
    request.tool.definition.metadata.name,
    request.input,
  );
  expect(performed.status).toBe('completed');
  expect(request.tool.execute).toHaveBeenCalledTimes(1);
  const newer = writer({ version: '2' });
  const nextInput = { value: '新版本应询问', expectedVersion: (await project()).version };
  expect(
    (
      await new ToolRegistry(context.pool, [newer.definition], { environment: 'test' }).execute(
        { ...request.reference, callId: randomUUID() },
        newer.definition.metadata.name,
        nextInput,
      )
    ).status,
  ).toBe('pending_approval');
  const { conversationId: _conversation, ...otherRun } = await context.run();
  expect(
    (await request.registry.execute(otherRun, request.tool.definition.metadata.name, nextInput))
      .status,
  ).toBe('pending_approval');
  await context.pool.query("UPDATE conversation SET permission_mode='read_only' WHERE id=$1", [
    request.conversationId,
  ]);
  await expect(
    request.registry.execute(
      { ...request.reference, callId: randomUUID() },
      request.tool.definition.metadata.name,
      nextInput,
    ),
  ).rejects.toMatchObject({ code: 'TOOL_READ_ONLY' });
  expect(request.tool.execute).toHaveBeenCalledTimes(1);
});

test('full直接写入但不产生会话授权；read_only目录无写工具也不创建批准请求', async () => {
  const tool = writer();
  const registry = new ToolRegistry(context.pool, [tool.definition], { environment: 'test' });
  const { conversationId, ...fullRun } = await context.run('MEMBER_A', 'full');
  expect(
    (
      await registry.execute(fullRun, tool.definition.metadata.name, {
        value: '完全允许测试',
        expectedVersion: (await project()).version,
      })
    ).status,
  ).toBe('completed');
  expect(
    (
      await context.pool.query(
        'SELECT count(*)::int AS count FROM conversation_tool_grant WHERE conversation_id=$1',
        [conversationId],
      )
    ).rows[0].count,
  ).toBe(0);
  const { conversationId: readConversation, ...readRun } = await context.run(
    'MEMBER_A',
    'read_only',
  );
  expect(await registry.catalog({ runId: readRun.runId, userId: readRun.userId })).toEqual([]);
  await expect(
    registry.execute(readRun, tool.definition.metadata.name, {
      value: '不应执行',
      expectedVersion: (await project()).version,
    }),
  ).rejects.toMatchObject({ code: 'TOOL_READ_ONLY' });
  expect(
    (
      await context.pool.query(
        'SELECT count(*)::int AS count FROM tool_approval WHERE conversation_id=$1',
        [readConversation],
      )
    ).rows[0].count,
  ).toBe(0);
});

test('批准前重验模式和目标状态；过期内容哈希不能批准', async () => {
  const request = await pending();
  const payload = await decisionInput(request.approvalId);
  expect(
    (await decide(request.approvalId, { ...payload, expectedContentHash: '0'.repeat(64) }))
      .statusCode,
  ).toBe(409);
  await context.pool.query("UPDATE conversation SET permission_mode='read_only' WHERE id=$1", [
    request.conversationId,
  ]);
  expect((await decide(request.approvalId, payload)).statusCode).toBe(409);
  await context.pool.query("UPDATE conversation SET permission_mode='ask' WHERE id=$1", [
    request.conversationId,
  ]);
  try {
    await context.pool.query("UPDATE goal SET status='paused' WHERE id=$1", [context.goalId]);
    expect((await decide(request.approvalId, payload)).statusCode).toBe(409);
  } finally {
    await context.pool.query("UPDATE goal SET status='active' WHERE id=$1", [context.goalId]);
  }
  expect(request.tool.execute).not.toHaveBeenCalled();
});

test('并发不同决定只有一个提交，禁用账号后Cookie也不能决定', async () => {
  const request = await pending();
  const payload = await decisionInput(request.approvalId);
  const responses = await Promise.all([
    decide(request.approvalId, payload),
    decide(request.approvalId, { ...payload, requestKey: randomUUID(), action: 'reject' }),
  ]);
  expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  expect(
    (
      await context.pool.query(
        'SELECT count(*)::int AS count FROM tool_approval_decision WHERE approval_id=$1',
        [request.approvalId],
      )
    ).rows[0].count,
  ).toBe(1);
  const next = await pending();
  try {
    await context.pool.query("UPDATE app_user SET status='disabled' WHERE id=$1", [
      next.reference.userId,
    ]);
    expect((await decide(next.approvalId, await decisionInput(next.approvalId))).statusCode).toBe(
      401,
    );
  } finally {
    await context.pool.query("UPDATE app_user SET status='active' WHERE id=$1", [
      next.reference.userId,
    ]);
  }
});

test('批准预览升密同步会话和运行，不把预览正文返回模型', async () => {
  const request = await pending({ level: 'confidential' });
  expect(request.result.dataLevel).toBe('confidential');
  expect(JSON.stringify(request.result.data)).not.toContain(request.input.value);
  expect(
    (
      await context.pool.query('SELECT max_data_level FROM conversation WHERE id=$1', [
        request.conversationId,
      ])
    ).rows[0].max_data_level,
  ).toBe('confidential');
  expect(
    (
      await context.pool.query('SELECT max_data_level FROM run WHERE id=$1', [
        request.reference.runId,
      ])
    ).rows[0].max_data_level,
  ).toBe('confidential');
});

test('需要先问的工具缺少可信预览不能登记', () => {
  const tool = writer();
  const { prepareApproval: _prepare, ...withoutPreview } = tool.definition;
  expect(() => new ToolRegistry(context.pool, [withoutPreview], { environment: 'test' })).toThrow(
    '可信操作预览',
  );
});

test('真实租约运行在预览期间停止，提交前检查使批准记录和审计整体回滚', async () => {
  const { conversationId: _conversation, ...reference } = await context.run();
  const controller = new AbortController();
  const tool = writer();
  const definition: typeof tool.definition = {
    ...tool.definition,
    async prepareApproval(ctx, input) {
      const preview = await tool.prepareApproval(ctx, input);
      controller.abort('approval_preview_stopped');
      return preview;
    },
  };
  const runtime = await createToolRuntime({
    pool: context.pool,
    definitions: [definition],
    runId: reference.runId,
    userId: reference.userId,
    ownerId: randomUUID(),
    signal: controller.signal,
    environment: 'test',
  });
  const auditCount = (
    await context.pool.query(
      "SELECT count(*)::int AS count FROM audit_log WHERE action='tool.approval_requested'",
    )
  ).rows[0].count;
  try {
    await expect(
      runtime.registry.execute(reference, definition.metadata.name, {
        value: '不得提交批准记录',
        expectedVersion: (await project()).version,
      }),
    ).rejects.toMatchObject({ code: 'TOOL_RUNTIME_INACTIVE' });
    expect(
      (
        await context.pool.query(
          'SELECT count(*)::int AS count FROM tool_approval WHERE run_id=$1',
          [reference.runId],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await context.pool.query(
          'SELECT count(*)::int AS count FROM tool_invocation WHERE run_id=$1',
          [reference.runId],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await context.pool.query(
          "SELECT count(*)::int AS count FROM audit_log WHERE action='tool.approval_requested'",
        )
      ).rows[0].count,
    ).toBe(auditCount);
    expect(tool.execute).not.toHaveBeenCalled();
    expect(tool.capture).not.toHaveBeenCalled();
  } finally {
    await releaseRunLease(context.pool, {
      runId: reference.runId,
      userId: reference.userId,
      ownerId: runtime.lease.ownerId,
      generation: runtime.lease.generation,
    });
  }
});
