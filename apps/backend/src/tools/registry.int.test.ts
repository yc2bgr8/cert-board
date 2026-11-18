import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import {
  browserIdentitySchema,
  type ToolMetadata,
  type BrowserIdentity,
  type DataLevel,
  type ToolCallContext,
} from '@cert-board/shared';
import { createTestDatabase } from '../db/test-database.js';
import { migrateDatabase } from '../db/migrate.js';
import { seedDevelopmentAccounts } from '../db/seed.js';
import { createProject } from '../projects/service.js';
import { AppError } from '../api/errors.js';
import { authorize } from '../auth/authorization.js';
import {
  ToolRegistry,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolUndoSpec,
} from './registry.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let ra: BrowserIdentity;
let rbId: string;
let projectId: string;
let goalId: string;
let conversationId: string;
let runId: string;
let caseNumber = 0;
const inputSchema = z
  .object({ value: z.string().max(2000), expectedVersion: z.number().int().positive() })
  .strict();
const outputSchema = z
  .object({
    projectId: z.string().uuid(),
    nextAction: z.string().nullable(),
    version: z.number().int().positive(),
  })
  .strict();
const beforeSchema = z.object({ nextAction: z.string().nullable() }).strict();
type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;

function metadata(name: string, effect: ToolMetadata['effect'] = 'read'): ToolMetadata {
  return {
    name,
    version: '1.0.0',
    publication: 'published',
    effect,
    approvalInAsk: false,
    modes: ['read_only', 'ask', 'full'],
    outputDataLevel: 'internal',
    authorizationAction: effect === 'read' ? 'project.read' : 'project.write',
    description: {
      purpose: '读取或修改本运行所属项目的下一步记录。',
      whenToUse: '需要核对当前项目记录时使用。',
      avoid: '不能审批；只读时使用read_note，不要猜测项目编号。',
      parameters: '写入提供value和expectedVersion；目标由运行身份确定。',
      example: { value: '示例下一步', expectedVersion: 1 },
    },
  };
}
function ref(callId: string): ToolCallContext {
  return { runId, userId: ra.userId, callId };
}
async function project() {
  return (
    await database.pool.query<{ next_action: string | null; version: number }>(
      'SELECT next_action,version FROM cert_project WHERE id=$1',
      [projectId],
    )
  ).rows[0]!;
}
async function record(ctx: ToolExecutionContext) {
  const result = await ctx.tx.query<{ next_action: string | null; version: number }>(
    'SELECT next_action,version FROM cert_project WHERE id=$1 FOR UPDATE',
    [ctx.projectId],
  );
  if (!result.rows[0]) throw new AppError(404, 'PROJECT_NOT_FOUND', '目标项目不存在');
  return result.rows[0];
}
function writer(options: { name?: string; fail?: boolean; invalidOutput?: boolean } = {}) {
  const execute = vi.fn(async (ctx: ToolExecutionContext, input: Input) => {
    const changed = await ctx.tx.query<{ id: string; next_action: string | null; version: number }>(
      'UPDATE cert_project SET next_action=$1,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$2 AND version=$3 RETURNING id,next_action,version',
      [input.value, ctx.projectId, input.expectedVersion],
    );
    if (!changed.rows[0]) throw new AppError(409, 'VERSION_CONFLICT', '目标版本已变');
    if (options.fail) throw new Error('CALLBACK_PRIVATE_BODY_MUST_NOT_ESCAPE');
    const row = changed.rows[0];
    const data = options.invalidOutput
      ? ('incorrect-output' as unknown as Output)
      : { projectId: row.id, nextAction: row.next_action, version: row.version };
    return { data, dataLevel: 'internal' as const, afterVersion: row.version };
  });
  const apply = vi.fn(
    async (
      ctx: ToolExecutionContext,
      undo: { targetId: string; beforeState: unknown; afterVersion: string },
    ) => {
      if (undo.targetId !== ctx.projectId)
        throw new AppError(403, 'TARGET_MISMATCH', '目标不属于当前运行');
      const before = beforeSchema.parse(undo.beforeState);
      const changed = await ctx.tx.query<{ version: number }>(
        'UPDATE cert_project SET next_action=$1,version=version+1 WHERE id=$2 AND version=$3 RETURNING version',
        [before.nextAction, undo.targetId, Number(undo.afterVersion)],
      );
      if (!changed.rows[0]) throw new AppError(409, 'VERSION_CONFLICT', '撤销目标版本已变');
      return { afterVersion: String(changed.rows[0].version) };
    },
  );
  const definition: ToolDefinition<Input, Output> = {
    metadata: metadata(options.name ?? 'write_note', 'reversible_write'),
    inputSchema,
    outputSchema,
    execute,
    undo: {
      beforeSchema,
      async capture(ctx, input) {
        const row = await record(ctx);
        if (row.version !== input.expectedVersion)
          throw new AppError(409, 'VERSION_CONFLICT', '目标版本已变');
        return {
          targetType: 'cert_project',
          targetId: ctx.projectId!,
          beforeState: { nextAction: row.next_action },
          beforeVersion: row.version,
        };
      },
      async currentVersion(ctx, undo) {
        if (undo.targetType !== 'cert_project' || undo.targetId !== ctx.projectId)
          throw new AppError(403, 'TARGET_MISMATCH', '目标不属于当前运行');
        const result = await ctx.tx.query<{ version: number }>(
          'SELECT version FROM cert_project WHERE id=$1 FOR UPDATE',
          [undo.targetId],
        );
        return result.rows[0]?.version ?? null;
      },
      apply,
    },
  };
  return { definition, execute, apply };
}
function reader() {
  const definition: ToolDefinition<Record<string, never>, Output> = {
    metadata: metadata('read_note'),
    inputSchema: z.object({}).strict(),
    outputSchema,
    async execute(ctx) {
      const row = await record(ctx);
      return {
        data: { projectId: ctx.projectId!, nextAction: row.next_action, version: row.version },
        dataLevel: 'internal',
      };
    },
  };
  return definition;
}
async function newRun(conversation = conversationId, userId = ra.userId) {
  const created = await database.pool.query<{ id: string }>(
    `INSERT INTO run(conversation_id,user_id,project_id,goal_id,direction_version,status,max_data_level)
    SELECT c.id,c.user_id,c.project_id,c.goal_id,g.direction_version,'running',c.max_data_level FROM conversation c JOIN goal g ON g.id=c.goal_id WHERE c.id=$1 AND c.user_id=$2 RETURNING id`,
    [conversation, userId],
  );
  return created.rows[0]!.id;
}

beforeAll(async () => {
  database = await createTestDatabase();
  await migrateDatabase(database.pool);
  const password = (role: string) => ['registry', 'integration', role, 'example'].join('-');
  await seedDevelopmentAccounts(database.pool, {
    NODE_ENV: 'test',
    DEV_ZHANGSAN_PASSWORD: password('zhangsan'),
    DEV_WANGMIN_PASSWORD: password('wangmin'),
    DEV_ADMIN_PASSWORD: password('admin'),
  });
  const users = await database.pool.query(
    "SELECT id,username,display_name FROM app_user WHERE username IN ('zhangsan','wangmin')",
  );
  const user = users.rows.find((row) => row.username === 'zhangsan');
  rbId = users.rows.find((row) => row.username === 'wangmin').id;
  ra = browserIdentitySchema.parse({
    kind: 'browser',
    userId: user.id,
    username: 'zhangsan',
    displayName: user.display_name,
    isDevelopment: true,
    sessionId: randomUUID(),
    isManagement: false,
  });
  await database.pool.query(
    'CREATE TABLE registry_test_proposal(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid NOT NULL,payload jsonb NOT NULL)',
  );
});
beforeEach(async () => {
  projectId = (
    await createProject(database.pool, ra, {
      name: `工具执行器测试${++caseNumber}`,
      projectType: 'registration',
      market: 'US',
      pathway: '510(k)',
      reviewerUserId: rbId,
    })
  ).id;
  goalId = (
    await database.pool.query<{ id: string }>(
      "INSERT INTO goal(project_id,owner_user_id,title,acceptance_criteria) VALUES($1,$2,'执行器测试目标','验证授权和原子性') RETURNING id",
      [projectId, ra.userId],
    )
  ).rows[0]!.id;
  conversationId = (
    await database.pool.query<{ id: string }>(
      "INSERT INTO conversation(project_id,user_id,goal_id,title,permission_mode) VALUES($1,$2,$3,'执行器测试对话','ask') RETURNING id",
      [projectId, ra.userId, goalId],
    )
  ).rows[0]!.id;
  runId = await newRun();
});
afterAll(async () => {
  if (database) await database.dispose();
});

test('同run+call并发仅一次效果，私有结果重放且参数变化拒绝', async () => {
  const tool = writer();
  const registry = new ToolRegistry(database.pool, [tool.definition]);
  const value = 'CONTROLLED_RESULT_ONLY';
  const results = await Promise.all([
    registry.execute(ref('same_call'), 'write_note', { value, expectedVersion: 1 }),
    registry.execute(ref('same_call'), 'write_note', { expectedVersion: 1, value }),
  ]);
  expect(tool.execute.mock.calls.length).toBe(1);
  expect(results.filter((result) => result.replayed)).toHaveLength(1);
  expect(results[0]!.invocationId).toBe(results[1]!.invocationId);
  expect(results[0]!.undoId).toBe(results[1]!.undoId);
  expect(await project()).toEqual({ next_action: value, version: 2 });
  await expect(
    registry.execute(ref('same_call'), 'write_note', { value: '其他输入', expectedVersion: 1 }),
  ).rejects.toMatchObject({ statusCode: 409, code: 'TOOL_IDEMPOTENCY_CONFLICT' });
  const invocation = await database.pool.query('SELECT * FROM tool_invocation WHERE run_id=$1', [
    runId,
  ]);
  expect(invocation.rowCount).toBe(1);
  expect(invocation.rows[0].arguments_hash).toMatch(/^[a-f0-9]{64}$/);
  const run = await database.pool.query('SELECT * FROM run WHERE id=$1', [runId]);
  const audits = await database.pool.query(
    "SELECT * FROM audit_log WHERE target_type='tool_invocation' AND target_id=$1",
    [results[0]!.invocationId],
  );
  expect(JSON.stringify([...invocation.rows, ...run.rows, ...audits.rows]).includes(value)).toBe(
    false,
  );
  const privateResult = await database.pool.query(
    'SELECT content_json FROM conversation_tool_result WHERE invocation_id=$1',
    [results[0]!.invocationId],
  );
  expect(JSON.stringify(privateResult.rows).includes(value)).toBe(true);
  const undo = await database.pool.query(
    'SELECT before_state,before_version,after_version,status FROM undo_record WHERE id=$1',
    [results[0]!.undoId],
  );
  expect(undo.rows[0]).toEqual({
    before_state: { nextAction: null },
    before_version: '1',
    after_version: '2',
    status: 'available',
  });
});

test.each([{ fail: true }, { invalidOutput: true }])(
  'handler失败或输出无效时业务、undo、调用和审计全部回滚 %j',
  async (options) => {
    const tool = writer(options);
    const registry = new ToolRegistry(database.pool, [tool.definition]);
    const beforeAudit = Number(
      (
        await database.pool.query(
          "SELECT count(*) AS count FROM audit_log WHERE action LIKE 'tool.%'",
        )
      ).rows[0].count,
    );
    let message = '';
    try {
      await registry.execute(ref('rollback'), 'write_note', {
        value: '不应落地',
        expectedVersion: 1,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.length > 0).toBe(true);
    expect(message.includes('CALLBACK_PRIVATE_BODY')).toBe(false);
    expect(await project()).toEqual({ next_action: null, version: 1 });
    expect(
      (await database.pool.query('SELECT id FROM tool_invocation WHERE run_id=$1', [runId]))
        .rowCount,
    ).toBe(0);
    expect(
      (await database.pool.query('SELECT id FROM undo_record WHERE run_id=$1', [runId])).rowCount,
    ).toBe(0);
    expect(
      (
        await database.pool.query(
          'SELECT id FROM conversation_tool_result WHERE conversation_id=$1',
          [conversationId],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      Number(
        (
          await database.pool.query(
            "SELECT count(*) AS count FROM audit_log WHERE action LIKE 'tool.%'",
          )
        ).rows[0].count,
      ),
    ).toBe(beforeAudit);
  },
);

test('目录和强行执行同策略：未知、未声明、无undo、未发布、不可逆与审批均拒绝', async () => {
  const tool = writer();
  const { undo: _undo, ...noUndo } = tool.definition;
  noUndo.metadata = { ...noUndo.metadata, name: 'no_undo' };
  const brokenUndo = {
    ...tool.definition,
    metadata: { ...tool.definition.metadata, name: 'broken_undo' },
    undo: { beforeSchema } as unknown as ToolUndoSpec<Input>,
  };
  const irreversible = {
    ...tool.definition,
    metadata: {
      ...tool.definition.metadata,
      name: 'destroy_record',
      effect: 'irreversible' as const,
    },
  };
  const draftTool = {
    ...reader(),
    metadata: { ...metadata('draft_reader'), publication: 'draft' as const },
  };
  const approval = {
    ...reader(),
    metadata: { ...metadata('approve_review'), authorizationAction: 'review.decide' as const },
  };
  const registry = new ToolRegistry(database.pool, [
    reader(),
    tool.definition,
    noUndo,
    brokenUndo,
    irreversible,
    draftTool,
    approval,
  ]);
  expect((await registry.catalog({ runId, userId: ra.userId })).map((item) => item.name)).toEqual([
    'read_note',
    'write_note',
  ]);
  for (const name of [
    'unknown_tool',
    'no_undo',
    'broken_undo',
    'destroy_record',
    'draft_reader',
    'approve_review',
  ]) {
    await expect(
      registry.execute(
        ref(name),
        name,
        ['draft_reader', 'approve_review'].includes(name)
          ? {}
          : { value: '禁止', expectedVersion: 1 },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  }
  expect(tool.execute.mock.calls.length).toBe(0);
  const { effect: _effect, ...undeclared } = tool.definition.metadata;
  expect(
    () =>
      new ToolRegistry(database.pool, [
        { ...tool.definition, metadata: undeclared as ToolMetadata },
      ]),
  ).toThrow('工具登记缺少');
});

test('自己的对话即使位于他人负责项目，也按真实会话owner授权并使用Agent身份', async () => {
  const ownConversation = (
    await database.pool.query<{ id: string }>(
      "INSERT INTO conversation(project_id,user_id,goal_id,title) VALUES($1,$2,$3,'另一用户自己的会话') RETURNING id",
      [projectId, rbId, goalId],
    )
  ).rows[0]!.id;
  const ownRun = await newRun(ownConversation, rbId);
  const definition: ToolDefinition<Record<string, never>, { ownerId: string; kind: 'agent' }> = {
    metadata: {
      ...metadata('owned_conversation'),
      authorizationAction: 'conversation.read',
    },
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ ownerId: z.uuid(), kind: z.literal('agent') }).strict(),
    async execute(ctx) {
      return { data: { ownerId: ctx.actor.userId, kind: ctx.actor.kind }, dataLevel: 'internal' };
    },
  };
  const registry = new ToolRegistry(database.pool, [definition]);
  const result = await registry.execute(
    { runId: ownRun, userId: rbId, callId: 'own_conversation' },
    'owned_conversation',
    {},
  );
  expect(result.data).toEqual({ ownerId: rbId, kind: 'agent' });
});

test('生产环境拒绝开发账号执行工具', async () => {
  const registry = new ToolRegistry(database.pool, [reader()], { environment: 'production' });
  await expect(registry.execute(ref('production'), 'read_note', {})).rejects.toMatchObject({
    code: 'TOOL_USER_INACTIVE',
  });
});

test('工作区已升为保密时，旧internal会话的静态工具也继承最高级别', async () => {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    const workspaceId = (
      await client.query<{ id: string }>(
        "INSERT INTO workspace(project_id,data_level) VALUES($1,'confidential') RETURNING id",
        [projectId],
      )
    ).rows[0]!.id;
    const versionId = (
      await client.query<{ id: string }>(
        "INSERT INTO workspace_version(workspace_id,project_id,number,author_type,summary,data_level) VALUES($1,$2,1,'system','保密工作区上下文测试','confidential') RETURNING id",
        [workspaceId, projectId],
      )
    ).rows[0]!.id;
    await client.query('UPDATE workspace SET current_version_id=$1 WHERE id=$2', [
      versionId,
      workspaceId,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const registry = new ToolRegistry(database.pool, [reader()]);
  const result = await registry.execute(ref('workspace_level'), 'read_note', {});
  expect(result.dataLevel).toBe('confidential');
  expect(
    (
      await database.pool.query('SELECT max_data_level FROM conversation WHERE id=$1', [
        conversationId,
      ])
    ).rows[0].max_data_level,
  ).toBe('confidential');
  expect(
    (await database.pool.query('SELECT max_data_level FROM run WHERE id=$1', [runId])).rows[0]
      .max_data_level,
  ).toBe('confidential');
});

test.each(['read_only', 'paused', 'human_controlled', 'cancelled'])(
  '当前模式或目标状态%s拒绝写入且仍可目录内读取',
  async (state) => {
    const tool = writer();
    const registry = new ToolRegistry(database.pool, [reader(), tool.definition]);
    if (state === 'read_only')
      await database.pool.query("UPDATE conversation SET permission_mode='read_only' WHERE id=$1", [
        conversationId,
      ]);
    else await database.pool.query('UPDATE goal SET status=$1 WHERE id=$2', [state, goalId]);
    expect((await registry.catalog({ runId, userId: ra.userId })).map((item) => item.name)).toEqual(
      ['read_note'],
    );
    await expect(
      registry.execute(ref('blocked'), 'write_note', { value: '不应写入', expectedVersion: 1 }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect((await registry.execute(ref('read'), 'read_note', {})).status).toBe('completed');
    expect(tool.execute.mock.calls.length).toBe(0);
  },
);

test('目标方向变化、停止运行、跨用户和账号停用都会拒绝调用', async () => {
  const registry = new ToolRegistry(database.pool, [reader(), writer().definition]);
  await expect(
    registry.execute({ runId, userId: rbId, callId: 'wrong_owner' }, 'read_note', {}),
  ).rejects.toMatchObject({ statusCode: 403 });
  await database.pool.query('UPDATE goal SET direction_version=direction_version+1 WHERE id=$1', [
    goalId,
  ]);
  await expect(registry.execute(ref('old_direction'), 'read_note', {})).rejects.toMatchObject({
    code: 'TOOL_DIRECTION_STALE',
  });
  runId = await newRun();
  await database.pool.query(
    "UPDATE run SET status='stopped',finished_at=CURRENT_TIMESTAMP WHERE id=$1",
    [runId],
  );
  await expect(registry.execute(ref('stopped'), 'read_note', {})).rejects.toMatchObject({
    code: 'TOOL_RUN_INACTIVE',
  });
  runId = await newRun();
  try {
    await database.pool.query("UPDATE app_user SET status='disabled' WHERE id=$1", [ra.userId]);
    await expect(registry.catalog({ runId, userId: ra.userId })).rejects.toMatchObject({
      code: 'TOOL_USER_INACTIVE',
    });
    await expect(
      registry.execute(ref('revoked'), 'write_note', { value: '禁止', expectedVersion: 1 }),
    ).rejects.toMatchObject({ statusCode: 403 });
  } finally {
    await database.pool.query("UPDATE app_user SET status='active' WHERE id=$1", [ra.userId]);
  }
});

test('外部动作从不调用execute，未接提案时明确待提案，接factory后只写本地提案', async () => {
  const execute = vi.fn(async () => ({
    data: { proposalId: randomUUID(), proposed: true },
    dataLevel: 'internal' as const,
  }));
  const pending: ToolDefinition<{ content: string }, { proposalId: string; proposed: boolean }> = {
    metadata: metadata('external_pending', 'external'),
    inputSchema: z.object({ content: z.string() }).strict(),
    outputSchema: z.object({ proposalId: z.uuid(), proposed: z.boolean() }).strict(),
    execute,
  };
  const registry = new ToolRegistry(database.pool, [pending]);
  const result = await registry.execute(ref('proposal_pending'), 'external_pending', {
    content: '此正文不应进入元数据',
  });
  expect(result.status).toBe('pending_proposal');
  expect(result.data).toMatchObject({ proposed: false, pending: true });
  expect(execute.mock.calls.length).toBe(0);
  const propose = vi.fn(async (ctx: ToolExecutionContext, input: { content: string }) => {
    const saved = await ctx.tx.query<{ id: string }>(
      'INSERT INTO registry_test_proposal(conversation_id,payload) VALUES($1,$2) RETURNING id',
      [ctx.conversationId, { content: input.content }],
    );
    return {
      data: { proposalId: saved.rows[0]!.id, proposed: true },
      dataLevel: 'internal' as const,
    };
  });
  const ready = { ...pending, metadata: metadata('external_ready', 'external'), propose };
  const registryReady = new ToolRegistry(database.pool, [ready]);
  const args = { content: '仅本地测试渠道' };
  expect((await registryReady.execute(ref('proposal_ready'), 'external_ready', args)).status).toBe(
    'pending_proposal',
  );
  expect(await registryReady.execute(ref('proposal_ready'), 'external_ready', args)).toMatchObject({
    status: 'pending_proposal',
    replayed: true,
  });
  expect(propose.mock.calls.length).toBe(1);
  expect(execute.mock.calls.length).toBe(0);
  expect(
    (
      await database.pool.query('SELECT id FROM registry_test_proposal WHERE conversation_id=$1', [
        conversationId,
      ])
    ).rowCount,
  ).toBe(1);
});

test('同一私有对话的新run可以撤销，重复undo不重复效果', async () => {
  const tool = writer();
  const registry = new ToolRegistry(database.pool, [tool.definition]);
  const done = await registry.execute(ref('write'), 'write_note', {
    value: '应可恢复',
    expectedVersion: 1,
  });
  expect(done.undoId).not.toBeNull();
  await database.pool.query(
    "UPDATE run SET status='completed',finished_at=CURRENT_TIMESTAMP WHERE id=$1",
    [runId],
  );
  runId = await newRun();
  const undone = await registry.undo(ref('undo'), done.undoId!);
  expect(undone.data).toMatchObject({ status: 'undone', afterVersion: '3', alreadyUndone: false });
  expect(await project()).toEqual({ next_action: null, version: 3 });
  expect((await registry.undo(ref('undo'), done.undoId!)).replayed).toBe(true);
  expect((await registry.undo(ref('undo_again'), done.undoId!)).data).toMatchObject({
    alreadyUndone: true,
  });
  expect(tool.apply.mock.calls.length).toBe(1);
  const record = await database.pool.query(
    'SELECT status,undone_version,undone_by FROM undo_record WHERE id=$1',
    [done.undoId],
  );
  expect(record.rows[0]).toEqual({ status: 'undone', undone_version: '3', undone_by: ra.userId });
});

test('后续人工改动、其他会话、只读或撤权不能撤销原记录', async () => {
  const tool = writer();
  const registry = new ToolRegistry(database.pool, [tool.definition]);
  const done = await registry.execute(ref('write'), 'write_note', {
    value: '初次写入',
    expectedVersion: 1,
  });
  await database.pool.query(
    "UPDATE cert_project SET next_action='后续人工修改',version=version+1 WHERE id=$1",
    [projectId],
  );
  await expect(registry.undo(ref('stale_undo'), done.undoId!)).rejects.toMatchObject({
    code: 'TOOL_UNDO_CONFLICT',
  });
  const otherConversation = (
    await database.pool.query<{ id: string }>(
      "INSERT INTO conversation(project_id,user_id,goal_id,title) VALUES($1,$2,$3,'另一私有对话') RETURNING id",
      [projectId, ra.userId, goalId],
    )
  ).rows[0]!.id;
  const otherRun = await newRun(otherConversation);
  await expect(
    registry.undo(
      { runId: otherRun, userId: ra.userId, callId: 'cross_conversation' },
      done.undoId!,
    ),
  ).rejects.toMatchObject({ code: 'TOOL_UNDO_FORBIDDEN' });
  await database.pool.query("UPDATE conversation SET permission_mode='read_only' WHERE id=$1", [
    conversationId,
  ]);
  await expect(registry.undo(ref('readonly_undo'), done.undoId!)).rejects.toMatchObject({
    statusCode: 403,
  });
  await database.pool.query("UPDATE conversation SET permission_mode='ask' WHERE id=$1", [
    conversationId,
  ]);
  try {
    await database.pool.query("UPDATE app_user SET status='disabled' WHERE id=$1", [ra.userId]);
    await expect(registry.undo(ref('revoked_undo'), done.undoId!)).rejects.toMatchObject({
      statusCode: 403,
    });
  } finally {
    await database.pool.query("UPDATE app_user SET status='active' WHERE id=$1", [ra.userId]);
  }
  expect(tool.apply.mock.calls.length).toBe(0);
  expect(await project()).toEqual({ next_action: '后续人工修改', version: 3 });
});

test('动态来源升密后重放不重做handler，刷新源级别并同步最高级；作废后拒绝重放', async () => {
  const doc = (
    await database.pool.query<{ id: string }>(
      "INSERT INTO document(project_id,source_key,name,source_path,owner_user_id) VALUES($1,'TOOL-SOURCE','受控测试资料','source.txt',$2) RETURNING id",
      [projectId, ra.userId],
    )
  ).rows[0]!.id;
  const addVersion = async (version: number, level: DataLevel) =>
    database.pool.query(
      "INSERT INTO document_version(document_id,version_no,source_snapshot,content_sha256,byte_size,media_type,content_kind,data_level,author_type) VALUES($1,$2,$3,$4,0,'text/plain','parsed_text',$5,'external')",
      [doc, version, String(version).repeat(64), 'a'.repeat(64), level],
    );
  await addVersion(1, 'internal');
  const refreshDataLevel = vi.fn(
    async (ctx: ToolExecutionContext, data: { documentId: string; text: string }) => {
      const found = await ctx.tx.query<{ data_level: DataLevel }>(
        `SELECT v.data_level FROM document d JOIN document_version v ON v.document_id=d.id WHERE d.id=$1 AND d.project_id=$2 AND NOT d.voided ORDER BY v.data_level DESC LIMIT 1`,
        [data.documentId, ctx.projectId],
      );
      if (!found.rows[0]) throw new AppError(404, 'DOCUMENT_NOT_FOUND', '不应暴露的原始错误正文');
      return found.rows[0].data_level;
    },
  );
  const execute = vi.fn(async () => ({
    data: { documentId: doc, text: 'DYNAMIC_PRIVATE_RESULT' },
    dataLevel: 'internal' as const,
  }));
  const definition: ToolDefinition<Record<string, never>, { documentId: string; text: string }> = {
    metadata: {
      ...metadata('dynamic_read'),
      authorizationAction: 'document.read',
      outputDataLevel: 'dynamic',
    },
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ documentId: z.uuid(), text: z.string() }).strict(),
    execute,
    refreshDataLevel,
  };
  const registry = new ToolRegistry(database.pool, [definition]);
  const initial = await registry.execute(ref('dynamic'), 'dynamic_read', {});
  expect(initial.dataLevel).toBe('internal');
  await addVersion(2, 'confidential');
  const repeated = await registry.execute(ref('dynamic'), 'dynamic_read', {});
  expect(execute.mock.calls.length).toBe(1);
  expect(repeated.replayed).toBe(true);
  expect(repeated.dataLevel).toBe('confidential');
  expect(
    (
      await database.pool.query('SELECT max_data_level FROM conversation WHERE id=$1', [
        conversationId,
      ])
    ).rows[0].max_data_level,
  ).toBe('confidential');
  expect(
    (await database.pool.query('SELECT max_data_level FROM run WHERE id=$1', [runId])).rows[0]
      .max_data_level,
  ).toBe('confidential');
  expect(
    (
      await database.pool.query('SELECT data_level FROM tool_invocation WHERE id=$1', [
        initial.invocationId,
      ])
    ).rows[0].data_level,
  ).toBe('confidential');
  expect(
    (
      await database.pool.query(
        'SELECT content_json FROM conversation_tool_result WHERE invocation_id=$1',
        [initial.invocationId],
      )
    ).rows[0].content_json.result.dataLevel,
  ).toBe('internal');
  await database.pool.query("UPDATE document SET voided=true,void_reason='测试作废' WHERE id=$1", [
    doc,
  ]);
  await expect(registry.execute(ref('dynamic'), 'dynamic_read', {})).rejects.toMatchObject({
    statusCode: 404,
    code: 'TOOL_TARGET_UNAVAILABLE',
  });
  const { refreshDataLevel: _resolver, ...withoutResolver } = definition;
  expect(() => new ToolRegistry(database.pool, [withoutResolver])).toThrow('动态资料工具必须');
});

test('已发布metadata被克隆冻结，调用方后续修改不改变目录', async () => {
  const definition = reader();
  const registry = new ToolRegistry(database.pool, [definition]);
  definition.metadata.publication = 'draft';
  definition.metadata.description.purpose = '不应替换已发布说明';
  definition.metadata.modes.splice(0, 3, 'full');
  const catalog = await registry.catalog({ runId, userId: ra.userId });
  expect(catalog).toHaveLength(1);
  expect(catalog[0]!.description.includes('不应替换')).toBe(false);
  expect((await registry.execute(ref('unchanged'), 'read_note', {})).status).toBe('completed');
});

test('动态写入工具的undo与重放用原业务回执定位来源，不把undo回执误当业务输出', async () => {
  const tool = writer({ name: 'dynamic_write' });
  let currentLevel: DataLevel = 'internal';
  const refreshDataLevel = vi.fn(async (ctx: ToolExecutionContext, data: Output) => {
    if (data.projectId !== ctx.projectId) throw new AppError(404, 'SOURCE_MISSING', '没有来源定位');
    return currentLevel;
  });
  const definition = {
    ...tool.definition,
    metadata: { ...tool.definition.metadata, outputDataLevel: 'dynamic' as const },
    refreshDataLevel,
  };
  const registry = new ToolRegistry(database.pool, [definition]);
  const created = await registry.execute(ref('dynamic_write'), 'dynamic_write', {
    value: '动态写入回归',
    expectedVersion: 1,
  });
  currentLevel = 'confidential';
  const undone = await registry.undo(ref('dynamic_undo'), created.undoId!);
  expect(undone.dataLevel).toBe('confidential');
  expect((await registry.undo(ref('dynamic_undo'), created.undoId!)).dataLevel).toBe(
    'confidential',
  );
  expect((await registry.undo(ref('dynamic_undo_again'), created.undoId!)).data).toMatchObject({
    alreadyUndone: true,
  });
  expect(tool.apply.mock.calls.length).toBe(1);
  expect(refreshDataLevel.mock.calls.length).toBe(4);
});

test('不同部门成员在自己的对话中拥有相同业务工具权限', async () => {
  const conversation = (
    await database.pool.query<{ id: string }>(
      "INSERT INTO conversation(project_id,user_id,goal_id,title,permission_mode) VALUES($1,$2,$3,'同等成员工具权限','ask') RETURNING id",
      [projectId, rbId, goalId],
    )
  ).rows[0]!.id;
  const ownRun = await newRun(conversation, rbId);
  const tool = writer();
  const registry = new ToolRegistry(database.pool, [tool.definition]);
  expect(
    (await registry.catalog({ runId: ownRun, userId: rbId })).map((item) => item.name),
  ).toEqual(['write_note']);
  await registry.execute(
    { runId: ownRun, userId: rbId, callId: 'same_business_permission' },
    'write_note',
    {
      value: '部门成员共同处理',
      expectedVersion: 1,
    },
  );
  expect(await project()).toEqual({ next_action: '部门成员共同处理', version: 2 });
  expect(tool.execute).toHaveBeenCalledTimes(1);
});

test('execute、capture、apply、refresh保持真实Agent身份，即使本人有管理权限也不能审批或管理', async () => {
  const tool = writer({ name: 'filtered_callbacks' });
  const originalUndo = tool.definition.undo!;
  const seen: {
    stage: string;
    kind: string;
    management: boolean;
    canApprove: boolean;
    canManage: boolean;
    frozen: boolean;
  }[] = [];
  const inspect = (ctx: ToolExecutionContext, stage: string) =>
    seen.push({
      stage,
      kind: ctx.actor.kind,
      management: ctx.actor.isManagement,
      canApprove: authorize(ctx.actor, 'approval.decide', { projectId, ownerUserId: ra.userId }),
      canManage: authorize(ctx.actor, 'admin.manage'),
      frozen: Object.isFrozen(ctx.actor),
    });
  const definition: ToolDefinition<Input, Output> = {
    ...tool.definition,
    metadata: {
      ...tool.definition.metadata,
      authorizationAction: 'record.write',
      outputDataLevel: 'dynamic',
    },
    async execute(ctx, input, before) {
      inspect(ctx, 'execute');
      return tool.definition.execute!(ctx, input, before);
    },
    async refreshDataLevel(ctx) {
      inspect(ctx, 'refresh');
      return 'internal';
    },
    undo: {
      ...originalUndo,
      async capture(ctx, input) {
        inspect(ctx, 'capture');
        return originalUndo.capture(ctx, input);
      },
      async currentVersion(ctx, record) {
        inspect(ctx, 'currentVersion');
        return originalUndo.currentVersion(ctx, record);
      },
      async apply(ctx, record) {
        inspect(ctx, 'apply');
        return originalUndo.apply(ctx, record);
      },
    },
  };
  await database.pool.query('UPDATE app_user SET is_management=true WHERE id=$1', [ra.userId]);
  try {
    const registry = new ToolRegistry(database.pool, [definition]);
    const caller = ref('member_callbacks');
    const result = await registry.execute(caller, 'filtered_callbacks', {
      value: '合法范围内修改',
      expectedVersion: 1,
    });
    await registry.undo({ ...caller, callId: 'filtered_undo' }, result.undoId!);
    for (const stage of ['execute', 'capture', 'currentVersion', 'apply', 'refresh'])
      expect(seen.some((item) => item.stage === stage)).toBe(true);
    expect(
      seen.every(
        (item) =>
          item.kind === 'agent' &&
          item.management &&
          !item.canApprove &&
          !item.canManage &&
          item.frozen,
      ),
    ).toBe(true);
  } finally {
    await database.pool.query('UPDATE app_user SET is_management=false WHERE id=$1', [ra.userId]);
  }
});

test('capture规范化snapshot只执行一次，strip字段不存储，改形状后仍可恢复原业务值', async () => {
  await database.pool.query(
    "UPDATE cert_project SET next_action='原始业务值',version=version+1 WHERE id=$1",
    [projectId],
  );
  const tool = writer({ name: 'normalized_capture' });
  const originalUndo = tool.definition.undo!;
  let capturedForExecute: unknown;
  const normalization = vi.fn((state: { rawValue: string | null }) => ({
    nextAction: state.rawValue,
  }));
  const definition: ToolDefinition<Input, Output> = {
    ...tool.definition,
    async execute(ctx, input, before) {
      capturedForExecute = before?.beforeState;
      return tool.definition.execute!(ctx, input, before);
    },
    undo: {
      ...originalUndo,
      beforeSchema: z.object({ rawValue: z.string().nullable() }).transform(normalization),
      async capture(ctx, input) {
        const original = await originalUndo.capture(ctx, input);
        return {
          ...original,
          beforeState: {
            rawValue: beforeSchema.parse(original.beforeState).nextAction,
            discardedMarker: 'RAW_CAPTURE_NOISE',
          },
        };
      },
    },
  };
  const registry = new ToolRegistry(database.pool, [definition]);
  const result = await registry.execute(ref('normalized'), 'normalized_capture', {
    value: '新业务值',
    expectedVersion: 2,
  });
  expect(capturedForExecute).toEqual({ nextAction: '原始业务值' });
  const stored = (
    await database.pool.query('SELECT before_state FROM undo_record WHERE id=$1', [result.undoId])
  ).rows[0].before_state;
  expect(stored).toEqual({ nextAction: '原始业务值' });
  await registry.undo(ref('normalized_undo'), result.undoId!);
  expect(await project()).toEqual({ next_action: '原始业务值', version: 4 });
  expect(normalization.mock.calls.length).toBe(1);
});

test('capture规范化后的JSON大小仍受64k上限约束', async () => {
  const tool = writer({ name: 'oversized_capture' });
  const definition: ToolDefinition<Input, Output> = {
    ...tool.definition,
    undo: {
      ...tool.definition.undo!,
      beforeSchema: beforeSchema.transform((state) => ({ ...state, padding: 'x'.repeat(64001) })),
    },
  };
  const registry = new ToolRegistry(database.pool, [definition]);
  await expect(
    registry.execute(ref('oversized'), 'oversized_capture', {
      value: '不应执行',
      expectedVersion: 1,
    }),
  ).rejects.toMatchObject({ code: 'TOOL_UNDO_CAPTURE_INVALID' });
  expect(tool.execute.mock.calls.length).toBe(0);
  expect(await project()).toEqual({ next_action: null, version: 1 });
});

test('修改业务值却不推进afterVersion的缺陷handler必须整事务回滚', async () => {
  const tool = writer({ name: 'bad_version_write' });
  const definition: ToolDefinition<Input, Output> = {
    ...tool.definition,
    async execute(ctx, input) {
      const row = (
        await ctx.tx.query<{ id: string; next_action: string; version: number }>(
          'UPDATE cert_project SET next_action=$1 WHERE id=$2 RETURNING id,next_action,version',
          [input.value, ctx.projectId],
        )
      ).rows[0]!;
      return {
        data: { projectId: row.id, nextAction: row.next_action, version: row.version },
        dataLevel: 'internal',
        afterVersion: row.version,
      };
    },
  };
  const registry = new ToolRegistry(database.pool, [definition]);
  await expect(
    registry.execute(ref('bad_version'), 'bad_version_write', {
      value: '无版本推进的错误写入',
      expectedVersion: 1,
    }),
  ).rejects.toMatchObject({ code: 'TOOL_WRITE_VERSION_INVALID' });
  expect(await project()).toEqual({ next_action: null, version: 1 });
  expect(
    (await database.pool.query('SELECT id FROM tool_invocation WHERE run_id=$1', [runId])).rowCount,
  ).toBe(0);
  expect(
    (await database.pool.query('SELECT id FROM undo_record WHERE run_id=$1', [runId])).rowCount,
  ).toBe(0);
});

test('回调不能改写撤销凭据的afterVersion来覆盖之后的人工修改', async () => {
  const tool = writer({ name: 'immutable_undo_snapshot' });
  const original = tool.definition.undo!;
  const definition: ToolDefinition<Input, Output> = {
    ...tool.definition,
    undo: {
      ...original,
      async currentVersion(ctx, record) {
        const actual = await original.currentVersion(ctx, record);
        if ('afterVersion' in record) record.afterVersion = String(actual);
        return actual;
      },
    },
  };
  const registry = new ToolRegistry(database.pool, [definition]);
  const created = await registry.execute(ref('write_snapshot'), 'immutable_undo_snapshot', {
    value: '原操作',
    expectedVersion: 1,
  });
  await database.pool.query(
    "UPDATE cert_project SET next_action='之后的人工修改',version=version+1 WHERE id=$1",
    [projectId],
  );
  await expect(registry.undo(ref('mutating_undo'), created.undoId!)).rejects.toMatchObject({
    statusCode: 500,
  });
  expect(tool.apply.mock.calls.length).toBe(0);
  expect(await project()).toEqual({ next_action: '之后的人工修改', version: 3 });
});
