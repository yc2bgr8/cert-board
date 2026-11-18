import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Notification } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createIntegrationContext } from '../test-support/context.js';
import { seedDevelopmentWorkspace } from '../workspace/seed.js';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import { claimRunLease, releaseRunLease } from '../runs/lease.js';
import { RUN_CONTROL_CHANNEL } from '../runs/control.js';
import { appendConversationEvent } from '../conversations/storage.js';
import { ToolRegistry, type ToolDefinition } from '../tools/registry.js';
import { agentInteractionTools } from '../tools/agent-interaction.js';
import { createReviewTestContext } from '../reviews/test-support.js';

class MemoryStore implements DocumentBlobStore {
  readonly objects = new Map<string, Buffer>();
  async put(content: Buffer) {
    const sha256 = createHash('sha256').update(content).digest('hex');
    this.objects.set(sha256, Buffer.from(content));
    return { sha256, byteSize: content.byteLength };
  }
  async get(hash: string) {
    const value = this.objects.get(hash);
    if (!value) throw new Error('缺少合成工作区对象');
    return Buffer.from(value);
  }
}
type Context = Awaited<ReturnType<typeof createIntegrationContext>>;
let c: Context;
let auth: Awaited<ReturnType<Context['login']>>;
beforeAll(async () => {
  c = await createIntegrationContext();
  await seedDevelopmentWorkspace(c.pool, new MemoryStore(), { NODE_ENV: 'test' });
  auth = await c.login();
});
afterAll(async () => {
  await c?.close();
});
const post = (
  url: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = auth.headers,
) => c.app.inject({ method: 'POST', url, payload, headers });
async function conversation() {
  const created = await post(`/api/projects/${c.projectId}/conversations`, {
    requestKey: randomUUID(),
  });
  expect(created.statusCode).toBe(200);
  return created.json().conversation.id as string;
}
async function running() {
  const conversationId = await conversation();
  const sent = await post(`/api/conversations/${conversationId}/messages`, {
    requestKey: randomUUID(),
    text: '合成初始任务',
  });
  expect(sent.statusCode).toBe(200);
  const runId = sent.json().runId as string;
  const userId = c.userId('MEMBER_A');
  const ownerId = randomUUID();
  const lease = await claimRunLease(c.pool, { runId, userId, ownerId });
  return { conversationId, runId, userId, ownerId, generation: lease.generation };
}
async function waitWithoutLease(run: Awaited<ReturnType<typeof running>>) {
  await releaseRunLease(c.pool, {
    runId: run.runId,
    userId: run.userId,
    ownerId: run.ownerId,
    generation: run.generation,
  });
  await c.pool.query("UPDATE run SET status='waiting',version=version+1 WHERE id=$1", [run.runId]);
}
it('项目内默认Agent/ask，项目外保存基本信息且禁止无项目发送，项目类型不接受伪造', async () => {
  const scoped = await post(`/api/projects/${c.projectId}/conversations`, {
    requestKey: randomUUID(),
  });
  expect(scoped.statusCode).toBe(200);
  expect(scoped.json()).toMatchObject({
    permissionVersion: 1,
    conversation: {
      projectId: c.projectId,
      goalId: c.goalId,
      agentCode: 'registration',
      permissionMode: 'ask',
      userId: c.userId('MEMBER_A'),
    },
  });
  const outside = await post('/api/conversations', { requestKey: randomUUID() });
  expect(outside.statusCode).toBe(200);
  expect(outside.json().conversation).toMatchObject({
    projectId: null,
    goalId: null,
    agentCode: 'registration',
    permissionMode: 'ask',
  });
  expect(
    (
      await post(`/api/conversations/${outside.json().conversation.id}/messages`, {
        requestKey: randomUUID(),
        text: '不能暗建业务目标',
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await post(`/api/projects/${c.projectId}/conversations`, {
        requestKey: randomUUID(),
        agentCode: 'maintenance',
      })
    ).statusCode,
  ).toBe(400);
  const maintenance = (
    await c.pool.query<{ id: string }>(
      "INSERT INTO cert_project(name,project_type,market,pathway,owner_user_id) VALUES('虚构维护事项','maintenance','US','annual',$1) RETURNING id",
      [c.userId('MEMBER_A')],
    )
  ).rows[0]!.id;
  const created = await post(`/api/projects/${maintenance}/conversations`, {
    requestKey: randomUUID(),
  });
  expect(created.statusCode).toBe(200);
  expect(created.json().conversation.agentCode).toBe('maintenance');
});
it('同一创建手势并发重试只建一次，改换正文或目标409', async () => {
  const payload = { requestKey: randomUUID(), title: '幂等新对话' };
  const responses = await Promise.all([
    post(`/api/projects/${c.projectId}/conversations`, payload),
    post(`/api/projects/${c.projectId}/conversations`, payload),
  ]);
  expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
  expect(new Set(responses.map((r) => r.json().conversation.id)).size).toBe(1);
  expect(responses.map((r) => r.json().replayed).sort()).toEqual([false, true]);
  expect(
    (await post(`/api/projects/${c.projectId}/conversations`, { ...payload, title: '变参' }))
      .statusCode,
  ).toBe(409);
  expect((await post('/api/conversations', payload)).statusCode).toBe(409);
  expect(
    (
      await c.pool.query(
        'SELECT id FROM conversation_command WHERE user_id=$1 AND request_key=$2',
        [c.userId('MEMBER_A'), payload.requestKey],
      )
    ).rowCount,
  ).toBe(1);
});
it('所有写入需要Cookie、CSRF与本站Origin，伪造身份/运行字段拒绝', async () => {
  const url = `/api/projects/${c.projectId}/conversations`;
  const payload = { requestKey: randomUUID() };
  const { cookie: _cookie, ...noCookie } = auth.headers;
  const { 'x-csrf-token': _csrf, ...noCsrf } = auth.headers;
  expect((await c.app.inject({ method: 'POST', url, payload, headers: noCookie })).statusCode).toBe(
    401,
  );
  expect((await c.app.inject({ method: 'POST', url, payload, headers: noCsrf })).statusCode).toBe(
    403,
  );
  expect(
    (await post(url, payload, { ...auth.headers, origin: 'https://untrusted.invalid' })).statusCode,
  ).toBe(403);
  expect(
    (await post(url, payload, { ...auth.headers, 'sec-fetch-site': 'cross-site' })).statusCode,
  ).toBe(403);
  expect(
    (await post(url, { ...payload, userId: c.userId('ADMIN'), isManagement: true })).statusCode,
  ).toBe(400);
  const id = await conversation();
  expect(
    (
      await post(`/api/conversations/${id}/messages`, {
        requestKey: randomUUID(),
        text: '测试',
        role: 'assistant',
        runId: randomUUID(),
      })
    ).statusCode,
  ).toBe(400);
});
it('其他部门成员和管理人员可以查看但不能代发消息、切模式、回答或停止', async () => {
  const run = await running();
  for (const member of ['MEMBER_B', 'ADMIN'] as const) {
    const other = await c.login(member);
    expect(
      (
        await c.app.inject({
          url: `/api/conversations/${run.conversationId}`,
          headers: other.headers,
        })
      ).json().canWrite,
    ).toBe(false);
    expect(
      (
        await post(
          `/api/conversations/${run.conversationId}/messages`,
          { requestKey: randomUUID(), text: '代发' },
          other.headers,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await c.app.inject({
          method: 'PATCH',
          url: `/api/conversations/${run.conversationId}/permission-mode`,
          payload: { requestKey: randomUUID(), expectedVersion: 1, permissionMode: 'full' },
          headers: other.headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await post(
          `/api/conversations/${run.conversationId}/answers`,
          { requestKey: randomUUID(), runId: run.runId, questionId: 'question', text: '代答' },
          other.headers,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await post(
          `/api/conversations/${run.conversationId}/stop`,
          { requestKey: randomUUID(), runId: run.runId },
          other.headers,
        )
      ).statusCode,
    ).toBe(404);
  }
  expect(
    (await c.pool.query('SELECT status FROM run WHERE id=$1', [run.runId])).rows[0]?.status,
  ).toBe('running');
  expect(
    (
      await c.pool.query('SELECT permission_mode FROM conversation WHERE id=$1', [
        run.conversationId,
      ])
    ).rows[0]?.permission_mode,
  ).toBe('ask');
});
it('并发新消息只有一个新运行，另一条成为原运行插话且不提前改写模型历史', async () => {
  const id = await conversation();
  const inputs = [
    { requestKey: randomUUID(), text: '并发任务甲' },
    { requestKey: randomUUID(), text: '并发任务乙' },
  ];
  const responses = await Promise.all(
    inputs.map((input) => post(`/api/conversations/${id}/messages`, input)),
  );
  expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
  expect(responses.map((r) => r.json().kind).sort()).toEqual(['queued', 'steering']);
  const runId = responses[0]!.json().runId as string;
  expect(responses[1]!.json().runId).toBe(runId);
  const queued = responses.findIndex((r) => r.json().kind === 'queued');
  const steered = responses.findIndex((r) => r.json().kind === 'steering');
  const messages = await c.pool.query(
    'SELECT message_json FROM conversation_message WHERE run_id=$1',
    [runId],
  );
  expect(messages.rows).toEqual([
    { message_json: { role: 'user', content: inputs[queued]!.text } },
  ]);
  const buffer = await c.pool.query(
    'SELECT content,delivered_at FROM run_steering_message WHERE run_id=$1',
    [runId],
  );
  expect(buffer.rows).toEqual([{ content: inputs[steered]!.text, delivered_at: null }]);
  const retry = await post(`/api/conversations/${id}/messages`, inputs[steered]!);
  expect(retry.json()).toMatchObject({ replayed: true, kind: 'steering', runId });
  expect(
    (await post(`/api/conversations/${id}/messages`, { ...inputs[queued], text: '同编号变参' }))
      .statusCode,
  ).toBe(409);
  expect((await c.pool.query('SELECT id FROM run WHERE conversation_id=$1', [id])).rowCount).toBe(
    1,
  );
  expect(
    (await c.pool.query('SELECT id FROM conversation_event WHERE conversation_id=$1', [id]))
      .rowCount,
  ).toBe(2);
});
it('运行中真实lease可接插话，失去执行权时保守拒绝且不新增buffer', async () => {
  const run = await running();
  expect(
    (
      await post(`/api/conversations/${run.conversationId}/messages`, {
        requestKey: randomUUID(),
        text: '有效执行权内的插话',
      })
    ).json().kind,
  ).toBe('steering');
  await releaseRunLease(c.pool, {
    runId: run.runId,
    userId: run.userId,
    ownerId: run.ownerId,
    generation: run.generation,
  });
  const rejected = await post(`/api/conversations/${run.conversationId}/messages`, {
    requestKey: randomUUID(),
    text: '不能投给orphan',
  });
  expect(rejected.statusCode).toBe(409);
  expect(rejected.json().error.code).toBe('CONVERSATION_RUN_RECOVERING');
  expect(
    (await c.pool.query('SELECT id FROM run_steering_message WHERE run_id=$1', [run.runId]))
      .rowCount,
  ).toBe(1);
});
it('权限CAS不随普通事件漂移，重复切换幂等，下一次工具读取新模式', async () => {
  const run = await running();
  await appendConversationEvent(c.pool, {
    runId: run.runId,
    userId: run.userId,
    requestKey: randomUUID(),
    event: { type: 'model_started', payload: {} },
  });
  const detail = await c.app.inject({
    url: `/api/conversations/${run.conversationId}`,
    headers: auth.headers,
  });
  expect(detail.json().permissionVersion).toBe(1);
  const payload = { requestKey: randomUUID(), expectedVersion: 1, permissionMode: 'read_only' };
  const mode = () =>
    c.app.inject({
      method: 'PATCH',
      url: `/api/conversations/${run.conversationId}/permission-mode`,
      headers: auth.headers,
      payload,
    });
  expect((await mode()).json()).toMatchObject({
    permissionMode: 'read_only',
    version: 2,
    replayed: false,
  });
  expect((await mode()).json()).toMatchObject({ version: 2, replayed: true });
  expect(
    (
      await c.app.inject({
        method: 'PATCH',
        url: `/api/conversations/${run.conversationId}/permission-mode`,
        headers: auth.headers,
        payload: { requestKey: randomUUID(), expectedVersion: 1, permissionMode: 'full' },
      })
    ).statusCode,
  ).toBe(409);
  const registry = new ToolRegistry(c.pool, agentInteractionTools());
  await expect(
    registry.execute(
      { runId: run.runId, userId: run.userId, callId: randomUUID() },
      'plan_update',
      { steps: [{ title: '不应执行', status: 'pending' }], progress: '测试' },
    ),
  ).rejects.toMatchObject({ code: 'TOOL_READ_ONLY' });
  expect(
    (
      await c.pool.query(
        "SELECT id FROM conversation_event WHERE conversation_id=$1 AND type='permission_changed'",
        [run.conversationId],
      )
    ).rowCount,
  ).toBe(1);
});
it('原ask_user的run+callId才能回答；普通消息不能冒充，回答幂等只建一次新运行', async () => {
  const run = await running();
  const questionId = randomUUID();
  const registry = new ToolRegistry(c.pool, agentInteractionTools());
  await registry.execute({ runId: run.runId, userId: run.userId, callId: questionId }, 'ask_user', {
    question: '请确认合成差异是否保留？',
    options: ['保留', '补充资料'],
  });
  await waitWithoutLease(run);
  expect(
    (
      await post(`/api/conversations/${run.conversationId}/messages`, {
        requestKey: randomUUID(),
        text: '普通消息不算回答',
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await post(`/api/conversations/${run.conversationId}/answers`, {
        requestKey: randomUUID(),
        runId: run.runId,
        questionId: '错误编号',
        text: '保留',
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await post(`/api/conversations/${run.conversationId}/answers`, {
        requestKey: randomUUID(),
        runId: run.runId,
        questionId: randomUUID(),
        text: '保留',
      })
    ).statusCode,
  ).toBe(409);
  const payload = {
    requestKey: randomUUID(),
    runId: run.runId,
    questionId,
    text: '保留两处原文，正确编号待确认。',
  };
  const responses = await Promise.all([
    post(`/api/conversations/${run.conversationId}/answers`, payload),
    post(`/api/conversations/${run.conversationId}/answers`, payload),
  ]);
  expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
  expect(new Set(responses.map((r) => r.json().runId)).size).toBe(1);
  expect(responses.map((r) => r.json().replayed).sort()).toEqual([false, true]);
  const nextRun = responses[0]!.json().runId as string;
  expect(nextRun).not.toBe(run.runId);
  expect(
    (await c.pool.query('SELECT status FROM run WHERE id=$1', [run.runId])).rows[0]?.status,
  ).toBe('completed');
  expect(
    (await c.pool.query('SELECT message_json FROM conversation_message WHERE run_id=$1', [nextRun]))
      .rows,
  ).toEqual([{ message_json: { role: 'user', content: payload.text } }]);
  expect(
    (await c.pool.query('SELECT id FROM conversation_answer WHERE source_run_id=$1', [run.runId]))
      .rowCount,
  ).toBe(1);
  expect(
    (
      await post(`/api/conversations/${run.conversationId}/answers`, {
        ...payload,
        requestKey: randomUUID(),
      })
    ).statusCode,
  ).toBe(409);
});
it('等待过程批准时对话中的已批准不能越过浏览器决定入口', async () => {
  const run = await running();
  const definition: ToolDefinition = {
    metadata: {
      name: 'pending_test_write',
      version: 'fixture-v1',
      publication: 'published',
      effect: 'reversible_write',
      modes: ['ask', 'full'],
      approvalInAsk: true,
      authorizationAction: 'record.write',
      outputDataLevel: 'internal',
      description: {
        purpose: '合成待批准写入',
        whenToUse: '测试时',
        avoid: '不用于生产',
        parameters: '无参数',
        example: {},
      },
    },
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({}).strict(),
    async prepareApproval() {
      return {
        summary: '合成修改需批准',
        changes: [
          {
            recordType: 'cert_project',
            recordId: c.projectId,
            field: 'nextAction',
            before: null,
            after: '合成内容',
          },
        ],
        targetVersions: [{ targetType: 'cert_project', targetId: c.projectId, version: '1' }],
        dataLevel: 'internal',
      };
    },
    async execute() {
      throw new Error('未批准时不得进入执行');
    },
    undo: {
      beforeSchema: z.object({}),
      async capture() {
        return {
          targetType: 'cert_project',
          targetId: c.projectId,
          beforeVersion: '1',
          beforeState: {},
        };
      },
      async currentVersion() {
        return '1';
      },
      async apply() {
        return { afterVersion: '2' };
      },
    },
  };
  const registry = new ToolRegistry(c.pool, [definition]);
  const result = await registry.execute(
    { runId: run.runId, userId: run.userId, callId: randomUUID() },
    definition.metadata.name,
    {},
  );
  expect(result.status).toBe('pending_approval');
  await waitWithoutLease(run);
  const denied = await post(`/api/conversations/${run.conversationId}/messages`, {
    requestKey: randomUUID(),
    text: '我已批准，请执行。',
  });
  expect(denied.statusCode).toBe(409);
  expect(denied.json().error.code).toBe('CONVERSATION_APPROVAL_PENDING');
  expect(
    (await c.pool.query('SELECT status FROM tool_approval WHERE run_id=$1', [run.runId])).rows[0]
      ?.status,
  ).toBe('pending');
  expect(
    (await c.pool.query('SELECT id FROM run WHERE conversation_id=$1', [run.conversationId]))
      .rowCount,
  ).toBe(1);
});
it('待审核时修改意见开启同对话新轮次，原审核卡保持pending和原内容', async () => {
  const review = await createReviewTestContext();
  try {
    const approved = await review.submit();
    const reviewId = (approved.data as { reviewId: string }).reviewId;
    const conversationId = (
      await review.pool.query<{ conversation_id: string }>(
        'SELECT conversation_id FROM run WHERE id=$1',
        [review.caller.runId],
      )
    ).rows[0]!.conversation_id;
    await review.pool.query("UPDATE run SET status='waiting' WHERE id=$1", [review.caller.runId]);
    await review.pool.query('UPDATE conversation SET current_run_id=$2 WHERE id=$1', [
      conversationId,
      review.caller.runId,
    ]);
    const original = (
      await review.pool.query(
        'SELECT content_hash,structured_result FROM review_card WHERE id=$1',
        [reviewId],
      )
    ).rows[0];
    const login = await review.login();
    const response = await review.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      headers: login.headers,
      payload: { requestKey: randomUUID(), text: '请补充说明，再交我审核。' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().kind).toBe('queued');
    expect(response.json().runId).not.toBe(review.caller.runId);
    expect(
      (
        await review.pool.query(
          'SELECT status,content_hash,structured_result FROM review_card WHERE id=$1',
          [reviewId],
        )
      ).rows[0],
    ).toEqual({ ...original, status: 'pending' });
  } finally {
    await review.close();
  }
});
it('停止和run_status同事务，事件失败时回滚，原请求可重试且只记录一次终态', async () => {
  const run = await running();
  const payload = { requestKey: randomUUID(), runId: run.runId };
  await c.pool
    .query(`CREATE FUNCTION fixture_reject_stop_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.type='run_status' THEN RAISE EXCEPTION '合成停止事件失败'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER fixture_reject_stop_event BEFORE INSERT ON conversation_event FOR EACH ROW EXECUTE FUNCTION fixture_reject_stop_event()`);
  try {
    expect((await post(`/api/conversations/${run.conversationId}/stop`, payload)).statusCode).toBe(
      500,
    );
    expect(
      (await c.pool.query('SELECT status FROM run WHERE id=$1', [run.runId])).rows[0]?.status,
    ).toBe('running');
  } finally {
    await c.pool.query(
      'DROP TRIGGER fixture_reject_stop_event ON conversation_event; DROP FUNCTION fixture_reject_stop_event()',
    );
  }
  const stopped = await post(`/api/conversations/${run.conversationId}/stop`, payload);
  expect(stopped.statusCode).toBe(200);
  expect(stopped.json()).toMatchObject({ stopped: true, replayed: false });
  expect(
    (await post(`/api/conversations/${run.conversationId}/stop`, payload)).json(),
  ).toMatchObject({ stopped: true, replayed: true });
  expect(
    (
      await c.pool.query(
        "SELECT id FROM conversation_event WHERE run_id=$1 AND type='run_status'",
        [run.runId],
      )
    ).rowCount,
  ).toBe(1);
  expect(
    (await c.pool.query('SELECT status,lease_owner FROM run WHERE id=$1', [run.runId])).rows[0],
  ).toEqual({ status: 'stopped', lease_owner: null });
});
it('已停止手势改绑新运行先拒绝，不能向新运行提前发出取消通知', async () => {
  const first = await running();
  const requestKey = randomUUID();
  expect(
    (
      await post(`/api/conversations/${first.conversationId}/stop`, {
        requestKey,
        runId: first.runId,
      })
    ).statusCode,
  ).toBe(200);
  const message = await post(`/api/conversations/${first.conversationId}/messages`, {
    requestKey: randomUUID(),
    text: '停止后新的合成任务',
  });
  expect(message.statusCode).toBe(200);
  const nextRunId = message.json().runId as string;
  await claimRunLease(c.pool, { runId: nextRunId, userId: first.userId, ownerId: randomUUID() });
  const listener = await c.pool.connect();
  const cancelled: string[] = [];
  const marker = randomUUID();
  let arrived!: () => void;
  const barrier = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const receive = (notice: Notification) => {
    if (notice.channel !== RUN_CONTROL_CHANNEL || !notice.payload) return;
    const data = JSON.parse(notice.payload) as { runId?: string; barrier?: string };
    if (data.runId) cancelled.push(data.runId);
    if (data.barrier === marker) arrived();
  };
  listener.on('notification', receive);
  try {
    await listener.query(`LISTEN ${RUN_CONTROL_CHANNEL}`);
    const refused = await post(`/api/conversations/${first.conversationId}/stop`, {
      requestKey,
      runId: nextRunId,
    });
    expect(refused.statusCode).toBe(409);
    await c.pool.query('SELECT pg_notify($1,$2)', [
      RUN_CONTROL_CHANNEL,
      JSON.stringify({ barrier: marker }),
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        barrier,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('通知屏障未到达')), 3000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    expect(cancelled).not.toContain(nextRunId);
    expect(
      (await c.pool.query('SELECT status FROM run WHERE id=$1', [nextRunId])).rows[0]?.status,
    ).toBe('running');
  } finally {
    await listener.query(`UNLISTEN ${RUN_CONTROL_CHANNEL}`);
    listener.removeListener('notification', receive);
    listener.release();
  }
});
