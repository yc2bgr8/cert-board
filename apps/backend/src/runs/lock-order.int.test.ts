import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createIntegrationContext } from '../test-support/context.js';
import { appendRunEvent } from './events.js';
import { claimRunLease, renewRunLease } from './lease.js';

let context: Awaited<ReturnType<typeof createIntegrationContext>>;
beforeEach(async () => {
  context = await createIntegrationContext();
});
afterEach(async () => {
  await context?.close();
});

test.each(['event', 'renew'])('%s遵守对话→运行锁顺序，不与工具事务互等', async (kind) => {
  const run = await context.run();
  const ownerId = randomUUID();
  const lease =
    kind === 'renew'
      ? await claimRunLease(context.pool, {
          runId: run.runId,
          userId: run.userId,
          ownerId,
        })
      : null;
  const blocker = await context.pool.connect();
  let open = false;
  let pending: Promise<unknown> | undefined;
  let failure: unknown;
  try {
    await blocker.query('BEGIN');
    open = true;
    await blocker.query('SELECT id FROM conversation WHERE id=$1 FOR UPDATE', [run.conversationId]);
    const operation =
      kind === 'event'
        ? appendRunEvent(context.pool, {
            runId: run.runId,
            userId: run.userId,
            event: { type: 'run_started' },
          })
        : renewRunLease(context.pool, {
            runId: run.runId,
            userId: run.userId,
            ownerId,
            generation: lease!.generation,
          });
    pending = operation.catch((error: unknown) => {
      failure = error;
    });
    const deadline = Date.now() + 5000;
    let waiting = false;
    while (Date.now() < deadline) {
      const state = await context.pool.query<{ waiting: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
         WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock') AS waiting`,
      );
      if (state.rows[0]!.waiting) {
        waiting = true;
        break;
      }
      await delay(10);
    }
    expect(waiting).toBe(true);
    // 旧顺序会让后台先持run再等conversation，此处因互等而超时；正确顺序仍能立即取得run。
    await blocker.query("SET LOCAL lock_timeout='800ms'");
    await blocker.query('SELECT id FROM run WHERE id=$1 FOR UPDATE', [run.runId]);
    await blocker.query('COMMIT');
    open = false;
    const result = await pending;
    expect(failure === undefined).toBe(true);
    if (kind === 'event') expect(result).toMatchObject({ runId: run.runId, seq: 1 });
    else expect(result).toMatchObject({ runId: run.runId, ownerId, generation: lease!.generation });
  } finally {
    if (open) await blocker.query('ROLLBACK');
    blocker.release();
    await pending;
  }
});
