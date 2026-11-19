import type { PgBoss } from 'pg-boss';
import type { Pool } from 'pg';
import { scanDeadlineReminders } from './scan.js';

export const deadlineQueue = 'cert-deadline-scan';

export async function startDeadlineQueue(boss: PgBoss, database: Pool) {
  await boss.createQueue(deadlineQueue, {
    retryLimit: 2,
    expireInSeconds: 120,
    retentionSeconds: 86400,
  });
  await boss.schedule(deadlineQueue, '*/5 * * * *', null, { tz: 'UTC' });
  await boss.work(
    deadlineQueue,
    { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 1 },
    async ([job]) => {
      if (job?.signal.aborted || !job) return;
      await scanDeadlineReminders(database).catch(() => {
        throw new Error('DEADLINE_SCAN_FAILED');
      });
    },
  );
  await boss.send(deadlineQueue, null, { singletonSeconds: 60 });
}
