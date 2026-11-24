import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import type { PgBoss } from 'pg-boss';
import type { Pool } from 'pg';
import type { DailyDigestContent } from '@cert-board/shared';
import { latestDigestNotices } from './daily-digest.js';
import { startDailyDigestQueue } from './daily-digest-queue.js';

test('重复的同一事项保留最新状态，同一对话的独立审批都保留', () => {
  const conversationId = randomUUID();
  const item = (kind: DailyDigestContent['pending'][number]['kind'], at: string) => ({
    id: randomUUID(),
    kind,
    conversationId,
    projectId: null,
    createdAt: at,
  });
  const latest = item('approval', '2030-01-08T08:54:00.000Z');
  const older = { ...latest, createdAt: '2030-01-08T07:54:00.000Z' };
  const separate = item('approval', '2030-01-08T07:00:00.000Z');
  const final = item('review', '2030-01-08T06:54:00.000Z');
  expect(latestDigestNotices([older, final, separate, latest])).toEqual([latest, separate, final]);
});

test('后台队列在北京时间工作日 17:00 生成站内日摘要', async () => {
  const calls = { createQueue: vi.fn(), schedule: vi.fn(), work: vi.fn(), send: vi.fn() };
  await startDailyDigestQueue(calls as unknown as PgBoss, {} as Pool);
  expect(calls.schedule).toHaveBeenCalledExactlyOnceWith(
    'cert-daily-digest',
    '0 17 * * 1-5',
    null,
    {
      tz: 'Asia/Shanghai',
    },
  );
  expect(calls.work).toHaveBeenCalledOnce();
  expect(calls.send).toHaveBeenCalledExactlyOnceWith('cert-daily-digest', null, {
    singletonSeconds: 60,
  });
});
