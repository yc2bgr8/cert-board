import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  browserIdentitySchema,
  reminderResultSchema,
  type PermissionMode,
} from '@cert-board/shared';
import { readMemberNotifications } from '../conversations/read.js';
import { createAgentQueue } from '../queue/agent-queue.js';
import { createIntegrationContext } from '../test-support/context.js';
import { deadlineCalcTool } from '../tools/deadline-calc.js';
import { ToolRegistry } from '../tools/registry.js';
import { reminderSetTool } from '../tools/reminder-set.js';
import { deadlineQueue, startDeadlineQueue } from './queue.js';
import { readDeadlineScanHeartbeat, scanDeadlineReminders } from './scan.js';

let context: Awaited<ReturnType<typeof createIntegrationContext>>;
beforeEach(async () => {
  context = await createIntegrationContext();
});
afterEach(async () => {
  await context?.close();
});

const plan = {
  title: '虚构证照到期提醒',
  profile: 'certificate',
  calculation: {
    startDate: '2026-05-01',
    quantity: 0,
    unit: 'calendar_days',
    jurisdictionTz: 'America/New_York',
  },
};

async function tools(mode: PermissionMode = 'full') {
  const run = await context.run('MEMBER_A', mode);
  const registry = new ToolRegistry(context.pool, [deadlineCalcTool(), reminderSetTool()]);
  const reference = () => ({ runId: run.runId, userId: run.userId, callId: randomUUID() });
  return {
    registry,
    reference,
    call: (name: string, input: object) => registry.execute(reference(), name, input),
  };
}

function browser(member: 'MEMBER_A' | 'MEMBER_B') {
  return browserIdentitySchema.parse({
    kind: 'browser',
    userId: context.userId(member),
    sessionId: randomUUID(),
    username: member === 'MEMBER_A' ? 'zhangsan' : 'wangmin',
    displayName: '合成验收',
    isDevelopment: true,
    isManagement: false,
  });
}

test('只读可算期限，请求批准模式先生成卡片，完全允许可更新并撤销', async () => {
  const read = await tools('read_only');
  expect((await read.call('deadline_calc', plan.calculation)).data).toMatchObject({
    dueAt: '2026-05-02T03:59:59.999Z',
  });
  await expect(read.call('reminder_set', plan)).rejects.toMatchObject({ code: 'TOOL_READ_ONLY' });
  const ask = await tools('ask');
  const pending = await ask.call('reminder_set', plan);
  expect(pending.status).toBe('pending_approval');
  expect((await context.pool.query('SELECT id FROM timer')).rowCount).toBe(0);
  const full = await tools();
  const initial = await full.call('reminder_set', plan);
  const created = reminderResultSchema.parse(initial.data);
  expect(created.goalId).toBe(context.goalId);
  await scanDeadlineReminders(context.pool, new Date('2026-01-31T12:00:00Z'));
  const pendingDeadline = async () =>
    (await readMemberNotifications(context.pool, browser('MEMBER_A'))).items.find(
      ({ kind }) => kind === 'deadline',
    );
  const before = (await pendingDeadline())!;
  const updated = await full.call('reminder_set', { ...plan, title: '调整标题' });
  expect(reminderResultSchema.parse(updated.data).version).toBe(created.version + 1);
  expect(await pendingDeadline()).toMatchObject({
    id: before.id,
    deadline: { title: '调整标题' },
  });
  await full.registry.undo(full.reference(), updated.undoId!);
  const row = (
    await context.pool.query<{ title: string; state: string }>('SELECT title,state FROM timer')
  ).rows[0];
  expect(row).toEqual({ title: plan.title, state: 'active' });
  expect(await pendingDeadline()).toMatchObject({
    id: before.id,
    deadline: { title: plan.title },
  });
});

test('到期合并、按法域跨日，站内提醒只对负责人显示和确认', async () => {
  const full = await tools();
  await full.call('reminder_set', plan);
  expect(await readDeadlineScanHeartbeat(context.pool)).toEqual({ lastSeenAt: null, stale: true });
  const instant = new Date('2026-01-31T12:00:00Z');
  expect(
    (
      await Promise.all([
        scanDeadlineReminders(context.pool, instant),
        scanDeadlineReminders(context.pool, instant),
      ])
    ).sort(),
  ).toEqual([0, 1]);
  const own = browser('MEMBER_A');
  const snapshot = await readMemberNotifications(context.pool, own);
  const first = snapshot.items.find(({ kind }) => kind === 'deadline')!;
  expect(first.deadline).toMatchObject({ stage: 'D-90', remainingDays: 90 });
  expect((await readMemberNotifications(context.pool, browser('MEMBER_B'))).items).toEqual([]);
  for (const [date, stage] of [
    ['2026-03-02', 'D-60'],
    ['2026-04-01', 'D-30'],
  ] as const) {
    await scanDeadlineReminders(context.pool, new Date(`${date}T12:00:00Z`));
    expect((await readMemberNotifications(context.pool, own)).items[0]).toMatchObject({
      id: first.id,
      deadline: { stage },
    });
  }

  // Beijing already entered May 2, but the deadline remains due today in New York.
  await scanDeadlineReminders(context.pool, new Date('2026-05-02T03:30:00Z'));
  const current = (await readMemberNotifications(context.pool, own)).items.find(
    ({ kind }) => kind === 'deadline',
  )!;
  expect(current.id).toBe(first.id);
  expect(current.deadline).toMatchObject({
    stage: 'D-0',
    remainingDays: 0,
    beijingTime: '2026-05-02 11:59:59',
  });
  const lan = await context.login('MEMBER_A');
  const other = await context.login('MEMBER_B');
  const url = `/api/deadline-notifications/${current.id}/acknowledge`;
  const payload = { seenAt: current.createdAt };
  const post = (headers: Record<string, string>, body = payload) =>
    context.app.inject({ method: 'POST', url, headers, payload: body });
  const { 'x-csrf-token': _csrf, ...withoutToken } = lan.headers;
  expect((await post(withoutToken)).statusCode).toBe(403);
  expect((await post(other.headers)).statusCode).toBe(409);
  expect((await post(lan.headers, { seenAt: first.createdAt })).statusCode).toBe(409);
  expect((await post(lan.headers)).statusCode).toBe(204);
  expect((await post(lan.headers)).statusCode).toBe(204);
  expect(await scanDeadlineReminders(context.pool, new Date('2026-05-02T03:40:00Z'))).toBe(0);
  expect((await readMemberNotifications(context.pool, own)).items).toEqual([]);

  const overdue = new Date('2026-05-02T04:05:00Z');
  expect(await scanDeadlineReminders(context.pool, overdue)).toBe(1);
  const late = (await readMemberNotifications(context.pool, own)).items.find(
    ({ kind }) => kind === 'deadline',
  )!;
  expect(late.id).not.toBe(first.id);
  expect(late.deadline).toMatchObject({ stage: 'OVERDUE', remainingDays: -1 });
  expect(await scanDeadlineReminders(context.pool, instant)).toBe(0);
  expect((await readMemberNotifications(context.pool, own)).items[0]?.deadline?.stage).toBe(
    'OVERDUE',
  );
  expect(
    await readDeadlineScanHeartbeat(context.pool, new Date('2026-05-02T04:14:59Z')),
  ).toMatchObject({ stale: false });
  expect(
    await readDeadlineScanHeartbeat(context.pool, new Date('2026-05-02T04:20:00Z')),
  ).toMatchObject({ stale: true });
});

test('节点期限只按七天、一天和逾期三种状态更新', async () => {
  const full = await tools();
  await full.call('reminder_set', { ...plan, profile: 'milestone' });
  const own = browser('MEMBER_A');
  for (const [date, stage] of [
    ['2026-04-24', 'D-7'],
    ['2026-04-30', 'D-1'],
    ['2026-05-02', 'OVERDUE'],
  ] as const) {
    await scanDeadlineReminders(context.pool, new Date(`${date}T12:00:00Z`));
    const snapshot = await readMemberNotifications(context.pool, own);
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]?.deadline?.stage).toBe(stage);
  }
});

test('撤销改期后恢复对应期限的提醒，其他期限的历史确认不抵消', async () => {
  const full = await tools();
  const on = (startDate: string) => ({ ...plan, calculation: { ...plan.calculation, startDate } });
  const asOf = new Date('2026-04-01T12:00:00Z');
  await full.call('reminder_set', on('2026-04-25'));
  await scanDeadlineReminders(context.pool, asOf);
  await context.pool.query("UPDATE notification SET status='acknowledged' WHERE status='pending'");
  await full.call('reminder_set', on('2026-05-01'));
  await scanDeadlineReminders(context.pool, asOf);
  const { undoId } = await full.call('reminder_set', on('2026-05-20'));
  await full.registry.undo(full.reference(), undoId!);
  expect(await scanDeadlineReminders(context.pool, asOf)).toBe(1);
  const pending = (await readMemberNotifications(context.pool, browser('MEMBER_A'))).items;
  expect(pending).toHaveLength(1);
  expect(pending[0]?.deadline).toMatchObject({ dueDate: '2026-05-01', stage: 'D-30' });
});

test('后台刷新剩余天数与确认并发，确认后的同阶段提醒不重建', async () => {
  const full = await tools();
  const created = await full.call('reminder_set', plan);
  await scanDeadlineReminders(context.pool, new Date('2026-04-01T12:00:00Z'));
  const first = (await readMemberNotifications(context.pool, browser('MEMBER_A'))).items[0]!;
  const lock = await context.pool.connect();
  let work: Promise<number> | undefined;
  try {
    await lock.query('BEGIN');
    await lock.query("UPDATE notification SET status='acknowledged' WHERE id=$1", [first.id]);
    work = scanDeadlineReminders(context.pool, new Date('2026-04-02T12:00:00Z'));
    await vi.waitFor(
      async () => {
        const blocked = await context.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'WITH calendar AS%'",
        );
        expect(blocked.rowCount).toBe(1);
      },
      { timeout: 3000 },
    );
    await lock.query('COMMIT');
    expect(await work).toBe(0);
    expect((await readMemberNotifications(context.pool, browser('MEMBER_A'))).items).toEqual([]);
    await full.registry.undo(full.reference(), created.undoId!);
    expect((await context.pool.query('SELECT state FROM timer')).rows).toEqual([
      { state: 'cancelled' },
    ]);
  } finally {
    await lock.query('ROLLBACK').catch(() => undefined);
    lock.release();
    await work?.catch(() => undefined);
  }
});

test('浏览器同会话批准后，后续同工具调用才可登记站内提醒', async () => {
  const ask = await tools('ask');
  const request = await ask.call('reminder_set', plan);
  const { approvalId } = z.object({ approvalId: z.uuid() }).parse(request.data);
  const row = (
    await context.pool.query<{ version: number; content_hash: string }>(
      'SELECT version,content_hash FROM tool_approval WHERE id=$1',
      [approvalId],
    )
  ).rows[0]!;
  const owner = await context.login('MEMBER_A');
  const response = await context.app.inject({
    method: 'POST',
    url: `/api/approvals/${approvalId}`,
    headers: owner.headers,
    payload: {
      requestKey: randomUUID(),
      expectedVersion: row.version,
      expectedContentHash: row.content_hash,
      action: 'allow_conversation',
    },
  });
  expect(response.statusCode).toBe(200);
  expect((await context.pool.query('SELECT id FROM timer')).rowCount).toBe(0);
  expect((await ask.call('reminder_set', plan)).status).toBe('completed');
  expect((await context.pool.query('SELECT id FROM timer')).rowCount).toBe(1);
});

test('pg-boss 登记扫描并执行启动补扫，数据库心跳可查', async () => {
  const admin = await context.login('ADMIN');
  const member = await context.login('MEMBER_A');
  const url = '/api/deadline-notifications/health';
  expect((await context.app.inject({ url, headers: member.headers })).statusCode).toBe(403);
  expect((await context.app.inject({ url, headers: admin.headers })).json()).toEqual({
    lastSeenAt: null,
    stale: true,
  });
  const connection = context.pool.options.connectionString;
  if (!connection) throw new Error('TEST_DATABASE_UNAVAILABLE');
  const boss = await createAgentQueue(connection, () => undefined, true);
  try {
    await startDeadlineQueue(boss, context.pool);
    const schedules = await boss.getSchedules();
    expect(schedules.some(({ name }) => name === deadlineQueue)).toBe(true);
    await vi.waitFor(
      async () => {
        expect((await readDeadlineScanHeartbeat(context.pool)).lastSeenAt).toEqual(
          expect.any(String),
        );
      },
      { timeout: 10000 },
    );
    expect((await context.app.inject({ url, headers: admin.headers })).json()).toMatchObject({
      stale: false,
    });
  } finally {
    await boss.stop({ graceful: false });
  }
});
