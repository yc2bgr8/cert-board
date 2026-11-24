import type { PgBoss } from 'pg-boss';
import type { Pool } from 'pg';
import { buildDailyDigests, dailyDigestHour, dailyDigestTimezone } from './daily-digest.js';

const queue = 'cert-daily-digest';

export async function startDailyDigestQueue(boss: PgBoss, database: Pool) {
  await boss.createQueue(queue, { retryLimit: 2, expireInSeconds: 120, retentionSeconds: 86400 });
  await boss.schedule(queue, `0 ${dailyDigestHour} * * 1-5`, null, { tz: dailyDigestTimezone });
  await boss.send(queue, null, { singletonSeconds: 60 });
  await boss.work(
    queue,
    { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 1 },
    async ([job]) => {
      if (!job || job.signal.aborted) return;
      await buildDailyDigests(database).catch(() => {
        throw new Error('DAILY_DIGEST_FAILED');
      });
    },
  );
}
