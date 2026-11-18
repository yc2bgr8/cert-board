import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { createIntegrationContext } from '../test-support/context.js';
import { claimRunLease } from '../runs/lease.js';
import { takeSteeringForLease } from './steering.js';

let context: Awaited<ReturnType<typeof createIntegrationContext>> | undefined;
afterEach(async () => {
  await context?.close();
  context = undefined;
});
async function setup() {
  const c = await createIntegrationContext();
  context = c;
  const source = await c.run('MEMBER_A', 'ask');
  const lease = await claimRunLease(c.pool, {
    runId: source.runId,
    userId: source.userId,
    ownerId: randomUUID(),
  });
  return {
    ...c,
    source,
    lease: {
      runId: source.runId,
      userId: source.userId,
      ownerId: lease.ownerId,
      generation: lease.generation,
    },
    async insert(content: string, run = source) {
      return (
        await c.pool.query<{ id: string }>(
          `INSERT INTO run_steering_message(run_id,conversation_id,user_id,request_key,content)
         VALUES($1,$2,$3,$4,$5) RETURNING id`,
          [run.runId, run.conversationId, run.userId, randomUUID(), content],
        )
      ).rows[0]!.id;
    },
  };
}

test('插话原文留存，分批遵守总量上限，事务投递一次且不重复发展示事件', async () => {
  const c = await setup();
  const contents = Array.from({ length: 5 }, (_, i) => `${i} ${'文'.repeat(7996)}\n `);
  const ids: string[] = [];
  for (const content of contents) ids.push(await c.insert(content));
  const first = await takeSteeringForLease(c.pool, c.lease);
  expect(first).toHaveLength(4);
  expect(first.map((item) => item.steeringId)).toEqual(ids.slice(0, 4));
  expect(first.map((item) => item.message.content)).toEqual(contents.slice(0, 4));
  expect(first.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
  const second = await takeSteeringForLease(c.pool, c.lease);
  expect(second).toHaveLength(1);
  expect(second[0]!.seq).toBe(5);
  expect(second[0]!.message.content).toBe(contents[4]);
  expect(await takeSteeringForLease(c.pool, c.lease)).toEqual([]);
  const preserved = (
    await c.pool.query<{ content: string; delivered_generation: string }>(
      'SELECT content,delivered_generation FROM run_steering_message WHERE run_id=$1 ORDER BY created_at,id',
      [c.source.runId],
    )
  ).rows;
  expect(preserved.map((row) => row.content)).toEqual(contents);
  expect(preserved.every((row) => row.delivered_generation === String(c.lease.generation))).toBe(
    true,
  );
  expect((await c.pool.query('SELECT id FROM conversation_message')).rowCount).toBe(5);
  expect((await c.pool.query('SELECT id FROM conversation_event')).rowCount).toBe(0);
  expect((await c.pool.query('SELECT id FROM run_event')).rowCount).toBe(0);
});

test('并发领取使用真实执行权，原run之外的插话不搬移，重复领取不重复追加', async () => {
  const c = await setup();
  const originalId = await c.insert('本运行中的插话');
  const other = await c.run('MEMBER_A', 'ask');
  const foreignId = await c.insert('另一个运行的原始输入', other);
  await expect(
    takeSteeringForLease(c.pool, { ...c.lease, ownerId: randomUUID() }),
  ).rejects.toMatchObject({ code: 'STEERING_LEASE_UNAVAILABLE' });
  await expect(
    takeSteeringForLease(c.pool, { ...c.lease, generation: c.lease.generation + 1 }),
  ).rejects.toMatchObject({ code: 'STEERING_LEASE_UNAVAILABLE' });
  await expect(
    takeSteeringForLease(c.pool, { ...c.lease, userId: c.userId('MEMBER_B') }),
  ).rejects.toMatchObject({ code: 'STEERING_LEASE_UNAVAILABLE' });
  const results = await Promise.all([
    takeSteeringForLease(c.pool, c.lease),
    takeSteeringForLease(c.pool, c.lease),
  ]);
  expect(results.flat()).toHaveLength(1);
  expect(results.flat()[0]!.steeringId).toBe(originalId);
  expect(
    (await c.pool.query('SELECT delivered_at FROM run_steering_message WHERE id=$1', [foreignId]))
      .rows[0]!.delivered_at,
  ).toBeNull();
  expect((await c.pool.query('SELECT id FROM conversation_message')).rowCount).toBe(1);
});

test('停止、归档、停用及到期执行权均不能消费原始插话', async () => {
  const c = await setup();
  const id = await c.insert('应保留等待人工核对的输入');
  await c.pool.query(
    "UPDATE run SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
    [c.source.runId],
  );
  await expect(takeSteeringForLease(c.pool, c.lease)).rejects.toMatchObject({
    code: 'STEERING_LEASE_UNAVAILABLE',
  });
  const replacement = await claimRunLease(c.pool, {
    runId: c.source.runId,
    userId: c.source.userId,
    ownerId: randomUUID(),
  });
  const lease = { ...c.lease, ownerId: replacement.ownerId, generation: replacement.generation };
  await c.pool.query("UPDATE app_user SET status='disabled',version=version+1 WHERE id=$1", [
    c.source.userId,
  ]);
  await expect(takeSteeringForLease(c.pool, lease)).rejects.toMatchObject({
    code: 'STEERING_LEASE_UNAVAILABLE',
  });
  await c.pool.query("UPDATE app_user SET status='active',version=version+1 WHERE id=$1", [
    c.source.userId,
  ]);
  await c.pool.query("UPDATE conversation SET status='archived',version=version+1 WHERE id=$1", [
    c.source.conversationId,
  ]);
  await expect(takeSteeringForLease(c.pool, lease)).rejects.toMatchObject({
    code: 'STEERING_LEASE_UNAVAILABLE',
  });
  await c.pool.query("UPDATE conversation SET status='active',version=version+1 WHERE id=$1", [
    c.source.conversationId,
  ]);
  await c.pool.query(
    "UPDATE run SET status='stopped',finished_at=clock_timestamp(),version=version+1 WHERE id=$1",
    [c.source.runId],
  );
  await expect(takeSteeringForLease(c.pool, lease)).rejects.toMatchObject({
    code: 'STEERING_LEASE_UNAVAILABLE',
  });
  const nextRunId = (
    await c.pool.query<{ id: string }>(
      "INSERT INTO run(conversation_id,user_id,project_id,goal_id,status) VALUES($1,$2,$3,$4,'queued') RETURNING id",
      [c.source.conversationId, c.source.userId, c.projectId, c.goalId],
    )
  ).rows[0]!.id;
  const nextLease = await claimRunLease(c.pool, {
    runId: nextRunId,
    userId: c.source.userId,
    ownerId: randomUUID(),
  });
  expect(
    await takeSteeringForLease(c.pool, {
      runId: nextRunId,
      userId: c.source.userId,
      ownerId: nextLease.ownerId,
      generation: nextLease.generation,
    }),
  ).toEqual([]);
  expect(
    (await c.pool.query('SELECT content,delivered_at FROM run_steering_message WHERE id=$1', [id]))
      .rows[0],
  ).toMatchObject({ content: '应保留等待人工核对的输入', delivered_at: null });
  expect((await c.pool.query('SELECT id FROM conversation_message')).rowCount).toBe(0);
});

test('投递标记失败时私有消息和序号一起回滚，原文可安全重试', async () => {
  const c = await setup();
  await c.insert('不能丢失，也不能重复。');
  await c.pool
    .query(`CREATE FUNCTION reject_fixture_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION '合成投递失败'; END; $$;
    CREATE TRIGGER reject_fixture_delivery BEFORE UPDATE ON run_steering_message FOR EACH ROW EXECUTE FUNCTION reject_fixture_delivery()`);
  await expect(takeSteeringForLease(c.pool, c.lease)).rejects.toMatchObject({
    code: 'STEERING_DELIVERY_FAILED',
  });
  expect((await c.pool.query('SELECT id FROM conversation_message')).rowCount).toBe(0);
  expect(
    (
      await c.pool.query('SELECT last_message_seq FROM conversation WHERE id=$1', [
        c.source.conversationId,
      ])
    ).rows[0]!.last_message_seq,
  ).toBe('0');
  expect(
    (await c.pool.query('SELECT delivered_at FROM run_steering_message')).rows[0]!.delivered_at,
  ).toBeNull();
  await c.pool.query('DROP TRIGGER reject_fixture_delivery ON run_steering_message');
  const delivered = await takeSteeringForLease(c.pool, c.lease);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]!.seq).toBe(1);
});
