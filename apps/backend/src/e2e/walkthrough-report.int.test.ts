import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { appendConversationEvent } from '../conversations/storage.js';
import { appendRunEvent } from '../runs/events.js';
import { createIntegrationContext } from '../test-support/context.js';
import { canRequestReviewResubmission, readReviewResubmissionStop } from './walkthrough-report.js';

test('只有运行账本记录工具失败时也拒绝浏览器再次提醒', async () => {
  const context = await createIntegrationContext();
  try {
    const { runId, conversationId, userId } = await context.run();
    await context.pool.query('UPDATE conversation SET current_run_id=$2 WHERE id=$1', [
      conversationId,
      runId,
    ]);
    await appendConversationEvent(context.pool, {
      runId,
      userId,
      requestKey: randomUUID(),
      event: {
        type: 'run_status',
        payload: { status: 'stopped', reasonCode: 'REVIEW_NOT_SUBMITTED' },
      },
    });
    const stop = () => readReviewResubmissionStop(context.pool, conversationId, runId);
    expect(await stop()).toEqual({ code: 'REVIEW_NOT_SUBMITTED', toolFailed: false });
    await appendRunEvent(context.pool, {
      runId,
      userId,
      event: { type: 'tool_failed', reasonCode: 'internal_error' },
    });
    const recorded = await stop();
    expect(recorded).toEqual({ code: 'REVIEW_NOT_SUBMITTED', toolFailed: true });
    expect(
      canRequestReviewResubmission(
        null,
        [],
        'stopped',
        recorded!.code,
        false,
        recorded!.toolFailed,
      ),
    ).toBe(false);
    await context.pool.query('UPDATE conversation SET current_run_id=NULL WHERE id=$1', [
      conversationId,
    ]);
    expect(await stop()).toBeUndefined();
  } finally {
    await context.close();
  }
});
