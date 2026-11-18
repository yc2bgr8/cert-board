import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { beforeEach, afterEach, expect, test } from 'vitest';
import {
  internalMessageQueuedSchema,
  toolApprovalPendingResultSchema,
  type PermissionMode,
} from '@cert-board/shared';
import { createIntegrationContext } from '../test-support/context.js';
import {
  reminderMonday,
  reminderSaturday,
  reminderSunday,
  setTestReminderClock,
} from '../test-support/internal-reminder-clock.js';
import { createToolRuntime } from '../agent/tool-runtime.js';
import { queueInternalMessageTool } from '../tools/queue-internal-message.js';
import { proposeExternalTool } from '../tools/propose-external.js';
import { processTestInternalMessage } from './internal.js';
import { AppError } from '../api/errors.js';
import { seedDevelopmentWorkspace } from '../workspace/seed.js';
import type { DocumentBlobStore } from '../documents/blob-store.js';

class MemoryStore implements DocumentBlobStore {
  values = new Map<string, Buffer>();
  async put(value: Buffer) {
    const sha256 = createHash('sha256').update(value).digest('hex');
    this.values.set(sha256, Buffer.from(value));
    return { sha256, byteSize: value.length };
  }
  async get(id: string) {
    const value = this.values.get(id);
    if (!value) throw new Error('fixture_missing');
    return Buffer.from(value);
  }
}

let context: Awaited<ReturnType<typeof createIntegrationContext>>;
let contactId: string;
beforeEach(async () => {
  context = await createIntegrationContext();
  await setTestReminderClock(context.pool);
  await seedDevelopmentWorkspace(context.pool, new MemoryStore(), { NODE_ENV: 'test' });
  contactId = (
    await context.pool.query<{ id: string }>(
      `INSERT INTO contact(project_id,name,address,source,created_by,internal_user_id)
    VALUES($1,'王敏','local-test-wangmin','可信开发绑定fixture',$2,$3) RETURNING id`,
      [context.projectId, context.userId('MEMBER_A'), context.userId('MEMBER_B')],
    )
  ).rows[0]!.id;
});

test.each([reminderSaturday, reminderSunday])(
  '北京时间周末 %s 不建立提醒队列或批准请求',
  async (instant) => {
    await setTestReminderClock(context.pool, instant);
    const ask = await runner('ask');
    const full = await runner('full');
    await expect(
      ask.registry.execute(ask.source, 'queue_internal_message', payload()),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      full.registry.execute(full.source, 'queue_internal_message', payload()),
    ).rejects.toBeInstanceOf(AppError);
    const counts = await context.pool
      .query(`SELECT (SELECT count(*)::int FROM internal_outbound_message) AS queue,
    (SELECT count(*)::int FROM tool_approval) AS approvals`);
    expect(counts.rows[0]).toEqual({ queue: 0, approvals: 0 });
  },
);

test('周五积压在北京时间周六处理时无回执，周一可新建一条', async () => {
  const run = await runner();
  const friday = internalMessageQueuedSchema.parse(
    (await run.registry.execute(run.source, 'queue_internal_message', payload())).data,
  );
  await setTestReminderClock(context.pool, reminderSaturday);
  await expect(
    context.pool.query(
      `UPDATE internal_outbound_message SET status='done',attempts=1,version=version+1,
       processed_at=clock_timestamp(),receipt_id=$2 WHERE id=$1`,
      [friday.queueId, randomUUID()],
    ),
  ).rejects.toMatchObject({ code: '23514' });
  const weekend = await processTestInternalMessage(context.pool, friday.queueId);
  expect(weekend).toMatchObject({ status: 'failed', attempts: 0, receipt: null });
  expect(weekend.reason).toContain('周末');
  await setTestReminderClock(context.pool, reminderMonday);
  const source = { ...run.source, callId: randomUUID() };
  const monday = internalMessageQueuedSchema.parse(
    (await run.registry.execute(source, 'queue_internal_message', payload())).data,
  );
  const processed = await processTestInternalMessage(context.pool, monday.queueId);
  expect(processed).toMatchObject({ status: 'done', attempts: 1 });
  expect(processed.receipt).not.toBeNull();
  await expect(
    run.registry.execute({ ...source, callId: randomUUID() }, 'queue_internal_message', payload()),
  ).rejects.toBeInstanceOf(AppError);
});

test('ask只生成有真实收件人预览的批准请求；浏览器允许一次仍不提前排队', async () => {
  const run = await runner('ask');
  const answer = await run.registry.execute(run.source, 'queue_internal_message', payload());
  expect(answer.status).toBe('pending_approval');
  const pending = toolApprovalPendingResultSchema.parse(answer.data);
  expect(
    (await context.pool.query('SELECT count(*)::int AS n FROM internal_outbound_message')).rows[0]
      .n,
  ).toBe(0);
  expect((await context.pool.query('SELECT count(*)::int AS n FROM undo_record')).rows[0].n).toBe(
    0,
  );
  const auth = await context.login('MEMBER_A');
  const read = await context.app.inject({
    method: 'GET',
    url: `/api/approvals/${pending.approvalId}`,
    headers: auth.headers,
  });
  expect(read.statusCode).toBe(200);
  expect(read.json().preview.message.recipientName).toBe('王敏');
  expect(read.json().preview.message.body).toBe(payload().body);
  const allowed = await context.app.inject({
    method: 'POST',
    url: `/api/approvals/${pending.approvalId}`,
    headers: auth.headers,
    payload: {
      requestKey: randomUUID(),
      expectedVersion: read.json().version,
      expectedContentHash: read.json().contentHash,
      action: 'allow_once',
    },
  });
  expect(allowed.statusCode).toBe(200);
  expect(allowed.json().executed).toBe(false);
  expect(
    (await context.pool.query('SELECT count(*)::int AS n FROM internal_outbound_message')).rows[0]
      .n,
  ).toBe(0);
  expect((await run.registry.execute(run.source, 'queue_internal_message', payload())).status).toBe(
    'pending_approval',
  );
});

test('只读拒绝内部排队；未绑定联系人不能冒充内部，公司外部在full也只能提案', async () => {
  const readonly = await runner('read_only');
  await expect(
    readonly.registry.execute(readonly.source, 'queue_internal_message', payload()),
  ).rejects.toBeInstanceOf(AppError);
  await context.pool.query(
    'UPDATE contact SET internal_user_id=NULL,version=version+1 WHERE id=$1',
    [contactId],
  );
  const full = await runner();
  await expect(
    full.registry.execute(full.source, 'queue_internal_message', payload()),
  ).rejects.toBeInstanceOf(AppError);
  const external = await full.registry.execute(
    { ...full.source, callId: randomUUID() },
    'propose_external',
    payload(),
  );
  expect(external.status).toBe('pending_proposal');
  expect(
    (await context.pool.query('SELECT count(*)::int AS n FROM internal_outbound_message')).rows[0]
      .n,
  ).toBe(0);
  expect(
    (await context.pool.query('SELECT count(*)::int AS n FROM outbound_message')).rows[0].n,
  ).toBe(0);
});

test('同一事项同收件人每日只可排一条，未处理撤销释放名额而旧call不可重做', async () => {
  const one = await runner(),
    two = await runner();
  const first = await one.registry.execute(one.source, 'queue_internal_message', payload());
  await expect(
    two.registry.execute(two.source, 'queue_internal_message', payload()),
  ).rejects.toBeInstanceOf(AppError);
  const undone = await one.registry.undo({ ...one.source, callId: randomUUID() }, first.undoId!);
  expect(undone.status).toBe('completed');
  await expect(
    one.registry.execute(one.source, 'queue_internal_message', payload()),
  ).rejects.toBeInstanceOf(AppError);
  const next = await two.registry.execute(
    { ...two.source, callId: randomUUID() },
    'queue_internal_message',
    payload(),
  );
  expect(next.status).toBe('completed');
  expect(
    (
      await context.pool.query(
        "SELECT count(*)::int AS n FROM internal_outbound_message WHERE status='queued'",
      )
    ).rows[0].n,
  ).toBe(1);
});

test('部门同事可暂停恢复，但恢复取消旧内部排队且处理器不会补发', async () => {
  const run = await runner();
  const queue = internalMessageQueuedSchema.parse(
    (await run.registry.execute(run.source, 'queue_internal_message', payload())).data,
  );
  const auth = await context.login('MEMBER_B');
  const version = (
    await context.pool.query('SELECT version FROM goal WHERE id=$1', [context.goalId])
  ).rows[0].version;
  const paused = await context.app.inject({
    method: 'POST',
    url: `/api/goals/${context.goalId}/outbound-control`,
    headers: auth.headers,
    payload: { expectedVersion: version, paused: true },
  });
  expect(paused.statusCode).toBe(200);
  expect((await processTestInternalMessage(context.pool, queue.queueId)).status).toBe('queued');
  const resumed = await context.app.inject({
    method: 'POST',
    url: `/api/goals/${context.goalId}/outbound-control`,
    headers: auth.headers,
    payload: { expectedVersion: paused.json().version, paused: false },
  });
  expect(resumed.statusCode).toBe(200);
  const result = await processTestInternalMessage(context.pool, queue.queueId);
  expect(result.status).toBe('cancelled');
  expect(result.attempts).toBe(0);
  expect(result.receipt).toBeNull();
});

test.each(['recipient', 'goal', 'conversation'] as const)(
  '发送前重新检查%s状态，不产生本地发送回执',
  async (target) => {
    const run = await runner();
    const queue = internalMessageQueuedSchema.parse(
      (await run.registry.execute(run.source, 'queue_internal_message', payload())).data,
    );
    if (target === 'recipient')
      await context.pool.query('UPDATE contact SET version=version+1 WHERE id=$1', [contactId]);
    if (target === 'goal')
      await context.pool.query("UPDATE goal SET status='cancelled',version=version+1 WHERE id=$1", [
        context.goalId,
      ]);
    if (target === 'conversation')
      await context.pool.query(
        "UPDATE conversation SET permission_mode='read_only',version=version+1 WHERE id=$1",
        [run.conversationId],
      );
    const result = await processTestInternalMessage(context.pool, queue.queueId);
    expect(result.status).toBe('failed');
    expect(result.attempts).toBe(0);
    expect(result.receipt).toBeNull();
  },
);

test('排队后仅工作区本体升密也必须阻断发送', async () => {
  const run = await runner();
  const queue = internalMessageQueuedSchema.parse(
    (await run.registry.execute(run.source, 'queue_internal_message', payload())).data,
  );
  await context.pool.query(
    "UPDATE workspace SET data_level='confidential',version=version+1 WHERE project_id=$1",
    [context.projectId],
  );
  expect((await processTestInternalMessage(context.pool, queue.queueId)).status).toBe('failed');
});

test('模拟读取昨日未处理队列，跨日失效且不释放为可重放发送', async () => {
  const run = await runner();
  const queue = internalMessageQueuedSchema.parse(
    (await run.registry.execute(run.source, 'queue_internal_message', payload())).data,
  );
  const connection = await context.pool.connect();
  const wrapped = new Proxy(connection, {
    get(target, key) {
      if (key === 'release') return () => undefined;
      if (key === 'query')
        return async (...args: unknown[]) => {
          const result = await Reflect.apply(target.query, target, args);
          if (
            typeof args[0] === 'string' &&
            args[0].startsWith(
              'SELECT *,business_date::text AS business_date FROM internal_outbound_message',
            )
          )
            result.rows = result.rows.map((row: Record<string, unknown>) => ({
              ...row,
              business_date: '2000-01-01',
            }));
          return result;
        };
      return Reflect.get(target, key);
    },
  }) as PoolClient;
  const pool = new Proxy(context.pool, {
    get(target, key) {
      return key === 'connect' ? async () => wrapped : Reflect.get(target, key);
    },
  });
  try {
    const result = await processTestInternalMessage(pool, queue.queueId);
    expect(result.status).toBe('failed');
    expect(result.attempts).toBe(0);
    expect(result.receipt).toBeNull();
  } finally {
    connection.release();
  }
});
afterEach(async () => {
  await context?.close();
});
async function runner(permissionMode: PermissionMode = 'full') {
  const source = await context.run('MEMBER_A', permissionMode);
  const runtime = await createToolRuntime({
    pool: context.pool,
    definitions: [queueInternalMessageTool(), proposeExternalTool()],
    ...source,
    ownerId: randomUUID(),
    signal: new AbortController().signal,
    environment: 'test',
  });
  return {
    ...runtime,
    source: { runId: source.runId, userId: source.userId, callId: source.callId },
    conversationId: source.conversationId,
  };
}
const payload = () => ({
  contactId,
  subject: '资料核对',
  body: '请补充本地合成资料。本测试不发送真实消息。',
});

test('full直接排入内部本地队列，幂等且没有外部提案；处理只生成一次本地回执', async () => {
  const run = await runner();
  const first = await run.registry.execute(run.source, 'queue_internal_message', payload());
  const value = internalMessageQueuedSchema.parse(first.data);
  expect(first.status).toBe('completed');
  expect(value.sent).toBe(false);
  expect(
    (await run.registry.execute(run.source, 'queue_internal_message', payload())).replayed,
  ).toBe(true);
  expect(
    (await context.pool.query('SELECT COUNT(*)::int AS n FROM internal_outbound_message')).rows[0]
      .n,
  ).toBe(1);
  expect((await context.pool.query('SELECT COUNT(*)::int AS n FROM proposal')).rows[0].n).toBe(0);
  expect((await context.pool.query('SELECT COUNT(*)::int AS n FROM tool_approval')).rows[0].n).toBe(
    0,
  );
  const done = await processTestInternalMessage(context.pool, value.queueId);
  expect(done.status).toBe('done');
  expect(done.attempts).toBe(1);
  expect(done.receipt?.channel).toBe('local_test');
  expect(
    await processTestInternalMessage(context.pool, value.queueId, { simulate: 'uncertain' }),
  ).toEqual(done);
  await expect(
    run.registry.undo({ ...run.source, callId: randomUUID() }, first.undoId!),
  ).rejects.toBeInstanceOf(AppError);
});
