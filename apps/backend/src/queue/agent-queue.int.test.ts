import { randomUUID } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createIntegrationContext } from '../test-support/context.js';
import { claimRunLease } from '../runs/lease.js';
import {
  AGENT_QUEUE,
  createAgentQueue,
  enqueueAgentRun,
  consumeAgentRuns,
  finishAbandonedAgentRun,
  recoverAbandonedAgentRuns,
} from './agent-queue.js';

let context: Awaited<ReturnType<typeof createIntegrationContext>>;
let boss: PgBoss | undefined;
beforeEach(async () => {
  context = await createIntegrationContext();
});
afterEach(async () => {
  if (boss) await boss.stop({ graceful: false });
  boss = undefined;
  await context?.close();
});
async function queue() {
  const connection = context.pool.options.connectionString;
  if (!connection) throw new Error('测试连接缺失');
  boss = await createAgentQueue(connection, () => undefined);
  return boss;
}
async function queued() {
  const run = await context.run();
  await context.pool.query("UPDATE run SET status='queued' WHERE id=$1", [run.runId]);
  return run;
}
async function finalJob(id: string) {
  await vi.waitFor(
    async () => {
      const value = await boss!.getJobById(AGENT_QUEUE, id);
      expect(value && ['completed', 'failed'].includes(value.state)).toBe(true);
    },
    { timeout: 5000, interval: 25 },
  );
  return (await boss!.getJobById(AGENT_QUEUE, id))!;
}

test('初始化后建队列失败会关闭真实pg-boss连接且不透传原始错误', async () => {
  const creation = vi
    .spyOn(PgBoss.prototype, 'createQueue')
    .mockRejectedValue(new Error('SYNTHETIC_PRIVATE_QUEUE_START_FAILURE'));
  try {
    await expect(
      createAgentQueue(context.pool.options.connectionString!, () => undefined),
    ).rejects.toThrow('AGENT_QUEUE_START_FAILED');
    await vi.waitFor(
      async () => {
        const connections = await context.pool.query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND application_name='cert-board-queue'",
        );
        expect(connections.rows[0]?.count).toBe(0);
      },
      { timeout: 3000 },
    );
  } finally {
    creation.mockRestore();
  }
});

test('真实pg-boss建队列、同run只入队一次，消费不保存handler正文输出', async () => {
  const source = await queue();
  const run = await queued();
  expect((await source.getQueue(AGENT_QUEUE))?.retryLimit).toBe(0);
  const ids = await Promise.all([
    enqueueAgentRun(source, run.runId),
    enqueueAgentRun(source, run.runId),
  ]);
  expect(ids.filter(Boolean)).toHaveLength(1);
  let calls = 0;
  await consumeAgentRuns(
    source,
    async (runId) => {
      expect(runId).toBe(run.runId);
      calls++;
      return { body: 'SYNTHETIC_PRIVATE_JOB_OUTPUT' } as never;
    },
    () => false,
  );
  const job = await finalJob(run.runId);
  expect(job.state).toBe('completed');
  expect(job.data).toEqual({ runId: run.runId });
  expect(job.output == null).toBe(true);
  expect(calls).toBe(1);
});

test('继续投递用票据编号去重，原运行初始投递仍可保留', async () => {
  const source = await queue();
  const run = await queued();
  const ticketId = randomUUID();
  const calls: Array<{ runId: string; ticketId?: string }> = [];
  expect(await enqueueAgentRun(source, run.runId)).toBe(run.runId);
  expect(await enqueueAgentRun(source, run.runId, ticketId)).toBe(ticketId);
  expect(await enqueueAgentRun(source, run.runId, ticketId)).toBeNull();
  await consumeAgentRuns(
    source,
    async (runId, _signal, ticket) => {
      calls.push({ runId, ...(ticket ? { ticketId: ticket } : {}) });
    },
    () => false,
  );
  expect((await finalJob(run.runId)).data).toEqual({ runId: run.runId });
  expect((await finalJob(ticketId)).data).toEqual({ runId: run.runId, ticketId });
  expect(calls).toEqual([{ runId: run.runId }, { runId: run.runId, ticketId }]);
});

test('队列错误只保存固定信息，未开始run落failed且不重放', async () => {
  const source = await queue();
  const run = await queued();
  let calls = 0;
  await consumeAgentRuns(
    source,
    async () => {
      calls++;
      throw Object.assign(new Error('SYNTHETIC_PRIVATE_CALLBACK_ERROR'), {
        secret: 'SYNTHETIC_PRIVATE_FIELD',
      });
    },
    () => false,
    async (runId) => {
      await finishAbandonedAgentRun(context.pool, runId, true);
    },
  );
  await enqueueAgentRun(source, run.runId);
  const job = await finalJob(run.runId);
  expect(job.state).toBe('failed');
  expect(JSON.stringify(job.output)).toContain('AGENT_JOB_FAILED');
  expect(JSON.stringify(job.output)).not.toContain('SYNTHETIC_PRIVATE');
  expect(
    (await context.pool.query('SELECT status FROM run WHERE id=$1', [run.runId])).rows[0].status,
  ).toBe('failed');
  expect(await enqueueAgentRun(source, run.runId)).toBeNull();
  expect(calls).toBe(1);
});

test('关闭期间晚到任务不能执行，活动任务收到pg-boss取消信号', async () => {
  const source = await queue();
  const first = await queued();
  let closing = true,
    calls = 0;
  await consumeAgentRuns(
    source,
    async () => {
      calls++;
    },
    () => closing,
    async (runId) => {
      await finishAbandonedAgentRun(context.pool, runId, true);
    },
  );
  await enqueueAgentRun(source, first.runId);
  expect((await finalJob(first.runId)).state).toBe('failed');
  expect(calls).toBe(0);
  closing = false;
  await source.offWork(AGENT_QUEUE);
  const second = await queued();
  let started = false,
    aborted = false;
  await consumeAgentRuns(
    source,
    async (_runId, signal) => {
      started = true;
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
    },
    () => closing,
  );
  await enqueueAgentRun(source, second.runId);
  await vi.waitFor(() => expect(started).toBe(true), { timeout: 5000 });
  closing = true;
  await source.stop({ graceful: false });
  expect(aborted).toBe(true);
});

test('过期或无执行权的running即使没有用量也收尾；新租约保持，恢复汇报只一份', async () => {
  const orphan = await context.run();
  const expired = await context.run();
  const active = await context.run();
  await claimRunLease(context.pool, {
    ...(({ runId, userId }) => ({ runId, userId }))(expired),
    ownerId: randomUUID(),
  });
  await context.pool.query(
    "UPDATE run SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
    [expired.runId],
  );
  const live = await claimRunLease(context.pool, {
    runId: active.runId,
    userId: active.userId,
    ownerId: randomUUID(),
  });
  expect((await recoverAbandonedAgentRuns(context.pool)).stopped).toBe(2);
  expect((await recoverAbandonedAgentRuns(context.pool)).stopped).toBe(0);
  const states = await context.pool.query<{ id: string; status: string }>(
    'SELECT id,status FROM run ORDER BY id',
  );
  expect(states.rows.find((row) => row.id === orphan.runId)?.status).toBe('stopped');
  expect(states.rows.find((row) => row.id === expired.runId)?.status).toBe('stopped');
  expect(states.rows.find((row) => row.id === active.runId)?.status).toBe('running');
  expect(
    (await context.pool.query('SELECT lease_owner FROM run WHERE id=$1', [active.runId])).rows[0]
      .lease_owner,
  ).toBe(live.ownerId);
  expect(
    (await context.pool.query('SELECT COUNT(*)::int AS count FROM conversation_event')).rows[0]
      .count,
  ).toBe(2);
  expect(
    (await context.pool.query('SELECT COUNT(*)::int AS count FROM usage_ledger')).rows[0].count,
  ).toBe(0);
});

test('旧候选恢复前被新执行者领取时，不能停止新租约', async () => {
  const run = await context.run();
  const first = await claimRunLease(context.pool, {
    runId: run.runId,
    userId: run.userId,
    ownerId: randomUUID(),
  });
  await context.pool.query(
    "UPDATE run SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
    [run.runId],
  );
  const current = await claimRunLease(context.pool, {
    runId: run.runId,
    userId: run.userId,
    ownerId: randomUUID(),
  });
  expect(current.generation).toBe(first.generation + 1);
  expect(await finishAbandonedAgentRun(context.pool, run.runId)).toBe(false);
  expect(
    (await context.pool.query('SELECT status,lease_owner FROM run WHERE id=$1', [run.runId]))
      .rows[0],
  ).toEqual({ status: 'running', lease_owner: current.ownerId });
});
