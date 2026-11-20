import { expect, test } from 'vitest';
import { createIntegrationContext } from '../test-support/context.js';
import { previewIsIdle } from './idle.js';

test('稳定预览要等正在运行或等待的对话结束', async () => {
  const context = await createIntegrationContext();
  try {
    const databaseUrl = context.pool.options.connectionString!;
    expect(await previewIsIdle(databaseUrl)).toBe(true);
    const { runId } = await context.run();
    expect(await previewIsIdle(databaseUrl)).toBe(false);
    await context.pool.query("UPDATE run SET status='waiting' WHERE id=$1", [runId]);
    expect(await previewIsIdle(databaseUrl)).toBe(false);
    await context.pool.query("UPDATE run SET status='completed' WHERE id=$1", [runId]);
    expect(await previewIsIdle(databaseUrl)).toBe(true);
  } finally {
    await context.close();
  }
});
