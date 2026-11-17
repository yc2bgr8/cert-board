import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { agentIdentitySchema } from '@cert-board/shared';
import { createIntegrationContext } from '../test-support/context.js';
import { seedDevelopmentBudgetPolicy, reserveUsage } from '../budget/service.js';
import { appendRunEvent, listRunEvents } from './events.js';
import { claimRunLease, renewRunLease, assertRunLease, releaseRunLease } from './lease.js';

let context: Awaited<ReturnType<typeof createIntegrationContext>>;
let run: Awaited<ReturnType<Awaited<ReturnType<typeof createIntegrationContext>>['run']>>;
const actor = () =>
  agentIdentitySchema.parse({
    kind: 'agent',
    runId: run.runId,
    userId: run.userId,
    username: 'ra',
    displayName: '注册人员A（开发）',
    isDevelopment: true,
    roles: [{ role: 'RA', scopeType: 'global', scopeId: null }],
  });
beforeAll(async () => {
  context = await createIntegrationContext();
  await seedDevelopmentBudgetPolicy(context.pool, 'test');
});
beforeEach(async () => {
  run = await context.run();
});
afterAll(async () => {
  if (context) await context.close();
});

test('事件只写白名单字段，正文参数凭据与错误对象被剔除', async () => {
  const marker = 'PRIVATE_BODY_NOT_FOR_RUN_EVENT';
  const event = await appendRunEvent(context.pool, {
    runId: run.runId,
    userId: run.userId,
    event: {
      type: 'tool_failed',
      reasonCode: 'internal_error',
      contentHash: 'a'.repeat(64),
      body: marker,
      arguments: { text: marker },
      OPENROUTER_API_KEY: marker,
      error: { message: marker },
    },
  });
  expect(event.seq).toBe(1);
  expect(event.reasonCode).toBe('internal_error');
  const stored = await context.pool.query(
    'SELECT to_jsonb(e) AS value FROM run_event e WHERE id=$1',
    [event.id],
  );
  expect(JSON.stringify(stored.rows).includes(marker)).toBe(false);
  expect('body' in stored.rows[0].value).toBe(false);
  expect('arguments' in stored.rows[0].value).toBe(false);
});

test('枚举和编号字段不能承载自由文本，拒绝后序号不推进', async () => {
  for (const event of [
    { type: '原文正文' },
    { type: 'tool_failed', reasonCode: '原始错误正文' },
    { type: 'model_started', requestId: 'not-a-uuid' },
    { type: 'model_completed', costNano: 'SECRET_TEXT' },
    { type: 'model_completed', contentHash: '原始资料' },
  ]) {
    await expect(
      appendRunEvent(context.pool, { runId: run.runId, userId: run.userId, event }),
    ).rejects.toMatchObject({ statusCode: 400 });
  }
  expect(
    Number(
      (await context.pool.query('SELECT last_event_seq FROM run WHERE id=$1', [run.runId])).rows[0]
        .last_event_seq,
    ),
  ).toBe(0);
});

test('并发事件序号单调唯一，私有列表支持断点续读', async () => {
  const events = await Promise.all(
    Array.from({ length: 8 }, () =>
      appendRunEvent(context.pool, {
        runId: run.runId,
        userId: run.userId,
        event: {
          type: 'model_completed',
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          costNano: '0',
        },
      }),
    ),
  );
  expect(events.map((event) => event.seq).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  const first = await listRunEvents(context.pool, actor(), run.runId, { limit: 3 });
  expect(first.items.map((event) => event.seq)).toEqual([1, 2, 3]);
  expect(first.nextAfterSeq).toBe(3);
  const next = await listRunEvents(context.pool, actor(), run.runId, {
    afterSeq: first.nextAfterSeq,
    limit: 5,
  });
  expect(next.items.map((event) => event.seq)).toEqual([4, 5, 6, 7, 8]);
  expect(next.hasMore).toBe(false);
  const other = {
    ...actor(),
    userId: context.userId('RB'),
    username: 'rb',
    roles: [{ role: 'RB' as const, scopeType: 'global' as const, scopeId: null }],
  };
  await expect(listRunEvents(context.pool, other, run.runId)).rejects.toMatchObject({
    statusCode: 404,
  });
  await expect(
    appendRunEvent(context.pool, {
      runId: run.runId,
      userId: context.userId('RB'),
      event: { type: 'run_completed' },
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
});

test('模型requestKey和工具invocation引用必须属于同一run', async () => {
  const requestKey = randomUUID();
  await reserveUsage(context.pool, {
    requestKey,
    runId: run.runId,
    userId: run.userId,
    modelId: 'scripted/events',
    purpose: 'evaluation',
    estimatedInputTokens: 10,
    maxOutputTokens: 2,
    prices: { inputUsdPerMillion: '0', cacheReadUsdPerMillion: '0', outputUsdPerMillion: '0' },
  });
  const invocation = (
    await context.pool.query<{ id: string }>(
      "INSERT INTO tool_invocation(run_id,conversation_id,user_id,call_id,tool_name,tool_version,arguments_hash,effect,status) VALUES($1,$2,$3,'event-fixture','read_fixture','1',$4,'read','completed') RETURNING id",
      [run.runId, run.conversationId, run.userId, 'b'.repeat(64)],
    )
  ).rows[0]!.id;
  const record = await appendRunEvent(context.pool, {
    runId: run.runId,
    userId: run.userId,
    event: { type: 'model_completed', requestId: requestKey, invocationId: invocation },
  });
  expect(record.requestId).toBe(requestKey);
  const other = await context.run();
  for (const event of [
    { type: 'model_completed', requestId: requestKey },
    { type: 'tool_completed', invocationId: invocation },
  ])
    await expect(
      appendRunEvent(context.pool, { runId: other.runId, userId: other.userId, event }),
    ).rejects.toMatchObject({ code: 'RUN_EVENT_REFERENCE_FORBIDDEN' });
  expect(
    Number(
      (await context.pool.query('SELECT last_event_seq FROM run WHERE id=$1', [other.runId]))
        .rows[0].last_event_seq,
    ),
  ).toBe(0);
});

test('执行事件在数据库层只追加', async () => {
  const event = await appendRunEvent(context.pool, {
    runId: run.runId,
    userId: run.userId,
    event: { type: 'run_started' },
  });
  await expect(
    context.pool.query("UPDATE run_event SET type='run_completed' WHERE id=$1", [event.id]),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    context.pool.query('DELETE FROM run_event WHERE id=$1', [event.id]),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(context.pool.query('TRUNCATE run_event')).rejects.toMatchObject({ code: '42501' });
});

test('两个owner竞争仅一个取得租约，同owner重试不续期，renew使用DB时钟', async () => {
  const one = randomUUID(),
    two = randomUUID();
  const results = await Promise.allSettled([
    claimRunLease(context.pool, {
      runId: run.runId,
      userId: run.userId,
      ownerId: one,
      ttlSeconds: 5,
    }),
    claimRunLease(context.pool, {
      runId: run.runId,
      userId: run.userId,
      ownerId: two,
      ttlSeconds: 5,
    }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const success = results.find((result) => result.status === 'fulfilled');
  if (success?.status !== 'fulfilled') throw new Error('没有租约持有者');
  const lease = success.value;
  expect(lease.generation).toBe(1);
  const repeated = await claimRunLease(context.pool, {
    runId: run.runId,
    userId: run.userId,
    ownerId: lease.ownerId,
    ttlSeconds: 300,
  });
  expect(repeated.expiresAt).toBe(lease.expiresAt);
  const renewed = await renewRunLease(context.pool, {
    runId: run.runId,
    userId: run.userId,
    ownerId: lease.ownerId,
    generation: lease.generation,
    ttlSeconds: 60,
  });
  expect(renewed.generation).toBe(1);
  expect(new Date(renewed.expiresAt).getTime() > new Date(lease.expiresAt).getTime()).toBe(true);
  const clock = (await context.pool.query<{ now: Date }>('SELECT clock_timestamp() AS now'))
    .rows[0]!.now;
  expect(new Date(renewed.expiresAt).getTime() > clock.getTime()).toBe(true);
});

test('过期租约不能续期；新持有者增加代次，旧代次不能断言或释放新租约', async () => {
  const first = await claimRunLease(context.pool, {
    runId: run.runId,
    userId: run.userId,
    ownerId: randomUUID(),
  });
  await context.pool.query(
    "UPDATE run SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
    [run.runId],
  );
  await expect(
    renewRunLease(context.pool, {
      runId: run.runId,
      userId: run.userId,
      ownerId: first.ownerId,
      generation: first.generation,
    }),
  ).rejects.toMatchObject({ code: 'RUN_LEASE_LOST' });
  const second = await claimRunLease(context.pool, {
    runId: run.runId,
    userId: run.userId,
    ownerId: randomUUID(),
  });
  expect(second.generation).toBe(2);
  const old = {
    runId: run.runId,
    userId: run.userId,
    ownerId: first.ownerId,
    generation: first.generation,
  };
  await expect(assertRunLease(context.pool, old)).rejects.toMatchObject({ code: 'RUN_LEASE_LOST' });
  await expect(releaseRunLease(context.pool, old)).rejects.toMatchObject({
    code: 'RUN_LEASE_LOST',
  });
  expect(
    (
      await assertRunLease(context.pool, {
        runId: run.runId,
        userId: run.userId,
        ownerId: second.ownerId,
        generation: second.generation,
      })
    ).generation,
  ).toBe(2);
});

test('释放不重置代次，停止运行不能再领取，跨用户执行权请求拒绝', async () => {
  const first = await claimRunLease(context.pool, {
    runId: run.runId,
    userId: run.userId,
    ownerId: randomUUID(),
  });
  await releaseRunLease(context.pool, {
    runId: run.runId,
    userId: run.userId,
    ownerId: first.ownerId,
    generation: first.generation,
  });
  const released = (
    await context.pool.query(
      'SELECT lease_owner,lease_generation,lease_expires_at FROM run WHERE id=$1',
      [run.runId],
    )
  ).rows[0];
  expect(released.lease_owner).toBeNull();
  expect(Number(released.lease_generation)).toBe(1);
  expect(released.lease_expires_at).toBeNull();
  const next = await claimRunLease(context.pool, {
    runId: run.runId,
    userId: run.userId,
    ownerId: first.ownerId,
  });
  expect(next.generation).toBe(2);
  await expect(
    claimRunLease(context.pool, {
      runId: run.runId,
      userId: context.userId('RB'),
      ownerId: randomUUID(),
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
  await context.pool.query(
    "UPDATE run SET status='stopped',finished_at=CURRENT_TIMESTAMP WHERE id=$1",
    [run.runId],
  );
  await expect(
    renewRunLease(context.pool, {
      runId: run.runId,
      userId: run.userId,
      ownerId: next.ownerId,
      generation: next.generation,
    }),
  ).rejects.toMatchObject({ code: 'RUN_LEASE_INACTIVE' });
  await releaseRunLease(context.pool, {
    runId: run.runId,
    userId: run.userId,
    ownerId: next.ownerId,
    generation: next.generation,
  });
  await expect(
    claimRunLease(context.pool, { runId: run.runId, userId: run.userId, ownerId: randomUUID() }),
  ).rejects.toMatchObject({ code: 'RUN_LEASE_INACTIVE' });
});
