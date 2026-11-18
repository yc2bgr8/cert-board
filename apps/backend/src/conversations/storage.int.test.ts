import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { Notification } from 'pg';
import type { AgentIdentity } from '@cert-board/shared';
import { createIntegrationContext, type MemberKey } from '../test-support/context.js';
import {
  appendConversationMessage,
  appendConversationEvent,
  listConversationMessages,
  listConversationEvents,
} from './storage.js';

type Context = Awaited<ReturnType<typeof createIntegrationContext>>;
let context: Context | undefined;
afterEach(async () => {
  await context?.close();
  context = undefined;
});
async function setup() {
  const c = await createIntegrationContext();
  context = c;
  const run = await c.run();
  const identity = (role: MemberKey = 'MEMBER_A'): AgentIdentity => ({
    kind: 'agent',
    runId: run.runId,
    userId: c.userId(role),
    username: role.toLowerCase(),
    displayName: '合成用户',
    isDevelopment: true,
    isManagement: false,
  });
  const input = {
    runId: run.runId,
    userId: run.userId,
    requestKey: randomUUID(),
    message: { role: 'user', content: '私有合成正文' },
  };
  return { ...c, createRun: c.run, run, identity, input };
}
it('并发同请求只保存一次、不耗额外序号，不同内容重放被拒且后续序号连续', async () => {
  const c = await setup();
  const results = await Promise.all([
    appendConversationMessage(c.pool, c.input),
    appendConversationMessage(c.pool, c.input),
  ]);
  expect(new Set(results.map((r) => r.id)).size).toBe(1);
  expect(results.map((r) => r.seq)).toEqual([1, 1]);
  await expect(
    appendConversationMessage(c.pool, { ...c.input, message: { role: 'user', content: '不同' } }),
  ).rejects.toMatchObject({ code: 'CONVERSATION_REQUEST_CONFLICT' });
  await Promise.all(
    Array.from({ length: 4 }, () =>
      appendConversationMessage(c.pool, { ...c.input, requestKey: randomUUID() }),
    ),
  );
  const first = await listConversationMessages(c.pool, c.identity(), c.run.conversationId, {
    limit: 2,
  });
  expect(first.items.map((r) => r.seq)).toEqual([1, 2]);
  expect(first.nextAfterSeq).toBe(2);
  const rest = await listConversationMessages(c.pool, c.identity(), c.run.conversationId, {
    afterSeq: 2,
  });
  expect(rest.items.map((r) => r.seq)).toEqual([3, 4, 5]);
  expect(rest.hasMore).toBe(false);
});
it('消息和过程序号独立，界面正文不进入白名单执行事件，撤权后即时拒读', async () => {
  const c = await setup();
  await appendConversationMessage(c.pool, c.input);
  const input = {
    runId: c.run.runId,
    userId: c.run.userId,
    requestKey: randomUUID(),
    event: {
      type: 'tool_completed',
      payload: { data: { text: '只存私有过程' }, name: 'doc_read' },
    },
  };
  const event = await appendConversationEvent(c.pool, input);
  const replay = await appendConversationEvent(c.pool, {
    ...input,
    event: {
      type: 'tool_completed',
      payload: { name: 'doc_read', data: { text: '只存私有过程' } },
    },
  });
  expect(event.seq).toBe(1);
  expect(replay.replayed).toBe(true);
  expect(
    (await listConversationEvents(c.pool, c.identity(), c.run.conversationId)).items[0]?.event,
  ).toEqual(input.event);
  expect((await c.pool.query('SELECT id FROM run_event')).rowCount).toBe(0);
  await c.pool.query("UPDATE app_user SET status='disabled' WHERE id=$1", [c.run.userId]);
  await expect(
    listConversationMessages(c.pool, c.identity(), c.run.conversationId),
  ).rejects.toMatchObject({ statusCode: 403 });
});
it('跨用户写入和错误运行绑定被拒，部门成员共享历史并继承最高数据级别', async () => {
  const c = await setup();
  await appendConversationMessage(c.pool, c.input);
  await expect(
    appendConversationMessage(c.pool, { ...c.input, userId: c.userId('MEMBER_B') }),
  ).rejects.toMatchObject({ statusCode: 404 });
  expect(
    (await listConversationMessages(c.pool, c.identity('MEMBER_B'), c.run.conversationId)).items,
  ).toHaveLength(1);
  await c.pool.query("UPDATE conversation SET max_data_level='confidential' WHERE id=$1", [
    c.run.conversationId,
  ]);
  expect(
    (await listConversationMessages(c.pool, c.identity(), c.run.conversationId)).items[0]
      ?.dataLevel,
  ).toBe('confidential');
  const saved = await appendConversationEvent(c.pool, {
    runId: c.run.runId,
    userId: c.run.userId,
    requestKey: randomUUID(),
    event: { type: 'run_status', payload: { status: 'waiting' } },
  });
  expect(
    (await c.pool.query('SELECT data_level FROM conversation_event WHERE id=$1', [saved.id]))
      .rows[0]?.data_level,
  ).toBe('confidential');
});
it('数据库连续序号、归属、只追加及reader拒读保护不依赖调用者校验', async () => {
  const c = await setup();
  await appendConversationMessage(c.pool, c.input);
  for (const table of ['conversation_message', 'conversation_event']) {
    for (const query of [
      `UPDATE ${table} SET content_hash=repeat('0',64)`,
      `DELETE FROM ${table}`,
      `TRUNCATE ${table}`,
    ]) {
      await expect(c.pool.query(query)).rejects.toMatchObject({ code: '42501' });
    }
    expect(
      (
        await c.pool.query<{ allowed: boolean }>(
          "SELECT has_table_privilege('cert_board_reader',$1,'SELECT') AS allowed",
          [table],
        )
      ).rows[0]?.allowed,
    ).toBe(false);
  }
  await expect(
    c.pool.query('UPDATE conversation SET last_message_seq=0 WHERE id=$1', [c.run.conversationId]),
  ).rejects.toMatchObject({ code: '42501' });
  const insert = `INSERT INTO conversation_message(run_id,conversation_id,user_id,request_key,seq,message_json,content_hash,data_level)
    VALUES($1,$2,$3,$4,$5,'{"role":"user","content":"合成"}',repeat('0',64),'internal')`;
  await expect(
    c.pool.query(insert, [c.run.runId, c.run.conversationId, c.run.userId, randomUUID(), 3]),
  ).rejects.toMatchObject({ code: '23514' });
  const other = await c.createRun('MEMBER_B');
  await expect(
    c.pool.query(insert, [other.runId, c.run.conversationId, c.run.userId, randomUUID(), 2]),
  ).rejects.toMatchObject({ code: '42501' });
  expect(
    (
      await c.pool.query('SELECT last_message_seq FROM conversation WHERE id=$1', [
        c.run.conversationId,
      ])
    ).rows[0]?.last_message_seq,
  ).toBe('1');
});

it('运行先升为保密时，追加私有内容同步提升对话级别，后续运行不能降级读取历史', async () => {
  const c = await setup();
  await c.pool.query("UPDATE run SET max_data_level='confidential' WHERE id=$1", [c.run.runId]);
  await appendConversationMessage(c.pool, c.input);
  expect(
    (
      await c.pool.query('SELECT max_data_level FROM conversation WHERE id=$1', [
        c.run.conversationId,
      ])
    ).rows[0]?.max_data_level,
  ).toBe('confidential');
});

it('事件提交后通知只含定位元数据，重放和提交回滚均不额外通知或消耗序号', async () => {
  const c = await setup();
  const listener = await c.pool.connect();
  const received: string[] = [];
  const receive = (message: Notification) => {
    if (message.channel === 'cert_board_conversation_events') received.push(message.payload ?? '');
  };
  listener.on('notification', receive);
  try {
    await listener.query('LISTEN cert_board_conversation_events');
    const input = {
      runId: c.run.runId,
      userId: c.run.userId,
      requestKey: randomUUID(),
      event: { type: 'tool_completed', payload: { text: 'PRIVATE_FIXTURE_CONTENT' } },
    };
    const first = await appendConversationEvent(c.pool, input);
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 1000, interval: 20 });
    expect(JSON.parse(received[0]!)).toEqual({
      conversationId: c.run.conversationId,
      eventId: first.id,
      seq: 1,
    });
    expect(received[0]).not.toContain('PRIVATE_FIXTURE_CONTENT');
    await appendConversationEvent(c.pool, input);
    await c.pool.query(`CREATE FUNCTION fail_history_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION '合成提交失败'; END; $$;
      CREATE CONSTRAINT TRIGGER fixture_history_commit_failure AFTER INSERT ON conversation_event
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_history_commit()`);
    await expect(
      appendConversationEvent(c.pool, { ...input, requestKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'CONVERSATION_APPEND_FAILED' });
    await listener.query('SELECT pg_sleep(0.05)');
    expect(received).toHaveLength(1);
    expect(
      (
        await c.pool.query('SELECT last_event_seq FROM conversation WHERE id=$1', [
          c.run.conversationId,
        ])
      ).rows[0]?.last_event_seq,
    ).toBe('1');
  } finally {
    await listener.query('UNLISTEN cert_board_conversation_events');
    listener.removeListener('notification', receive);
    listener.release();
  }
});
