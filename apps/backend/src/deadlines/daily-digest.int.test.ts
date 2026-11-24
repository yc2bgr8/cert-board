import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { dailyDigestResponseSchema } from '@cert-board/shared';
import { createIntegrationContext } from '../test-support/context.js';
import { createAgentQueue } from '../queue/agent-queue.js';
import { ToolRegistry } from '../tools/registry.js';
import { reminderSetTool } from '../tools/reminder-set.js';
import { buildDailyDigests } from './daily-digest.js';
import { startDailyDigestQueue } from './daily-digest-queue.js';
import { scanDeadlineReminders } from './scan.js';

test('工作日截止按北京时间，一日一份，分人展示完成、待办和当地到期', async () => {
  const context = await createIntegrationContext();
  try {
    const memberA = context.userId('MEMBER_A');
    const memberB = context.userId('MEMBER_B');
    const deadlineRun = await context.run('MEMBER_A', 'full');
    const registry = new ToolRegistry(context.pool, [reminderSetTool()], { environment: 'test' });
    await registry.execute(
      { runId: deadlineRun.runId, userId: memberA, callId: randomUUID() },
      'reminder_set',
      {
        title: '合成证照明日到期',
        profile: 'certificate',
        calculation: {
          startDate: '2030-01-09',
          quantity: 0,
          unit: 'calendar_days',
          jurisdictionTz: 'America/New_York',
        },
      },
    );
    await context.pool.query("UPDATE run SET status='completed' WHERE id=$1", [deadlineRun.runId]);
    await context.pool.query(
      `INSERT INTO goal(project_id,owner_user_id,title,acceptance_criteria,status,updated_at)
        VALUES($1,$2,'成员甲的合成完成事项','虚构验收','completed','2030-01-08T08:30:00Z'),
          ($1,$3,'成员乙的合成完成事项','虚构验收','completed','2030-01-08T08:30:00Z'),
          ($1,$2,'截止后的合成完成事项','虚构验收','completed','2030-01-08T09:30:00Z')`,
      [context.projectId, memberA, memberB],
    );
    await scanDeadlineReminders(context.pool, new Date('2030-01-08T08:59:00Z'));
    expect(await buildDailyDigests(context.pool, new Date('2030-01-08T08:59:59Z'))).toBe(0);
    expect(await buildDailyDigests(context.pool, new Date('2030-01-12T10:00:00Z'))).toBe(0);
    const publication = new Date('2030-01-08T09:00:00Z');
    const concurrent = await Promise.all([
      buildDailyDigests(context.pool, publication),
      buildDailyDigests(context.pool, publication),
    ]);
    expect(concurrent.reduce((total, count) => total + count, 0)).toBe(2);
    expect(await buildDailyDigests(context.pool, new Date('2030-01-08T11:00:00Z'))).toBe(0);

    const first = await context.login('MEMBER_A');
    const second = await context.login('MEMBER_B');
    const admin = await context.login('ADMIN');
    const url = '/api/me/daily-digest';
    const read = async (headers: Record<string, string>) => {
      const response = await context.app.inject({ url, headers });
      expect(response.statusCode).toBe(200);
      return dailyDigestResponseSchema.parse(response.json()).digest;
    };
    const summary = await read(first.headers);
    expect(summary).toMatchObject({
      date: '2030-01-08',
      generatedAt: publication.toISOString(),
      completed: [{ title: '成员甲的合成完成事项' }],
      pending: [{ kind: 'deadline', conversationId: deadlineRun.conversationId }],
      tomorrow: [
        { title: '合成证照明日到期', dueOn: '2030-01-09', jurisdictionTz: 'America/New_York' },
      ],
      localTestMessages: [],
    });
    expect((await read(second.headers))?.completed).toMatchObject([
      { title: '成员乙的合成完成事项' },
    ]);
    expect(await read(admin.headers)).toBeNull();
    expect((await context.app.inject({ url })).statusCode).toBe(403);
    expect(
      (await context.app.inject({ url: `${url}?userId=${memberB}`, headers: first.headers }))
        .statusCode,
    ).toBe(400);
    const pending = summary!.pending[0]!;
    const { rows: newerThreads } = await context.pool.query<{ id: string }>(
      `INSERT INTO conversation (project_id,user_id,goal_id,title,permission_mode,agent_code)
       SELECT $1,$2,$3,'合成截点后提示','full','registration' FROM generate_series(1,52)
       RETURNING id`,
      [context.projectId, memberA, context.goalId],
    );
    const newerIds = newerThreads.map(({ id }) => id);
    await context.pool.query(
      `INSERT INTO run(conversation_id,user_id,project_id,goal_id,status,updated_at)
       SELECT id,user_id,project_id,goal_id,'failed','2030-01-08T10:00:00Z'
       FROM conversation WHERE id=ANY($1::uuid[])`,
      [newerIds],
    );
    await context.pool.query(
      `UPDATE conversation c SET current_run_id=r.id FROM run r
       WHERE c.id=r.conversation_id AND c.id=ANY($1::uuid[])`,
      [newerIds],
    );
    expect((await read(first.headers))?.pending.map(({ id }) => id)).toEqual([pending.id]);
    expect(
      (
        await context.app.inject({
          method: 'POST',
          url: `/api/deadline-notifications/${pending.id}/acknowledge`,
          headers: first.headers,
          payload: { seenAt: pending.createdAt },
        })
      ).statusCode,
    ).toBe(204);
    expect((await read(first.headers))?.pending).toEqual([]);
    await expect(
      context.pool.query('DELETE FROM daily_digest WHERE user_id=$1', [memberA]),
    ).rejects.toMatchObject({ code: '55000' });
  } finally {
    await context.close();
  }
});

test('明日按每条期限的法域计算，延迟采样按实际时刻登记', async () => {
  const context = await createIntegrationContext();
  try {
    const { runId, userId, callId } = await context.run('MEMBER_A', 'full');
    const registry = new ToolRegistry(context.pool, [reminderSetTool()], { environment: 'test' });
    await registry.execute({ runId, userId, callId }, 'reminder_set', {
      title: '合成檀香山当地明日到期',
      profile: 'certificate',
      calculation: {
        startDate: '2030-01-08',
        quantity: 0,
        unit: 'calendar_days',
        jurisdictionTz: 'Pacific/Honolulu',
      },
    });
    await buildDailyDigests(context.pool, new Date('2030-01-08T09:00:00Z'));
    const browser = await context.login('MEMBER_A');
    const read = async () =>
      dailyDigestResponseSchema.parse(
        (
          await context.app.inject({ url: '/api/me/daily-digest', headers: browser.headers })
        ).json(),
      ).digest;
    expect((await read())?.tomorrow).toMatchObject([
      { dueOn: '2030-01-08', jurisdictionTz: 'Pacific/Honolulu' },
    ]);
    await context.pool.query(
      `INSERT INTO goal(project_id,owner_user_id,title,acceptance_criteria,status,updated_at)
       VALUES($1,$2,'合成延迟采样已完成目标','合成验收','completed','2030-01-09T09:45:00Z')`,
      [context.projectId, userId],
    );
    await buildDailyDigests(context.pool, new Date('2030-01-09T10:00:00Z'));
    expect(await read()).toMatchObject({
      date: '2030-01-09',
      generatedAt: '2030-01-09T10:00:00.000Z',
      completed: [{ title: '合成延迟采样已完成目标' }],
    });
  } finally {
    await context.close();
  }
});

test('在实际 pg-boss 中登记站内日摘要任务', async () => {
  const context = await createIntegrationContext();
  try {
    const connection = context.pool.options.connectionString;
    if (!connection) throw new Error('TEST_DATABASE_UNAVAILABLE');
    const boss = await createAgentQueue(connection, () => undefined, true);
    try {
      await startDailyDigestQueue(boss, context.pool);
      expect((await boss.getSchedules()).some(({ name }) => name === 'cert-daily-digest')).toBe(
        true,
      );
    } finally {
      await boss.stop({ graceful: false });
    }
  } finally {
    await context.close();
  }
});
