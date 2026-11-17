import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createIntegrationContext } from '../test-support/context.js';
import { seedDevelopmentBudgetPolicy, reserveUsage } from '../budget/service.js';
import { retainModelRequest, purgeExpiredModelRequests } from './request-retention.js';

let context: Awaited<ReturnType<typeof createIntegrationContext>>;
const content = { messages: [{ role: 'user' as const, content: '仅用于清理测试的合成资料正文' }] };
const policy = { environment: 'test', retentionDays: 1 };
async function request() {
  const { runId, userId } = await context.run();
  const requestId = randomUUID();
  await reserveUsage(context.pool, {
    requestKey: requestId,
    runId,
    userId,
    modelId: 'scripted/retention',
    purpose: 'evaluation',
    estimatedInputTokens: 1,
    maxOutputTokens: 1,
    prices: { inputUsdPerMillion: '0', cacheReadUsdPerMillion: '0', outputUsdPerMillion: '0' },
  });
  return { requestId, runId, userId, synthetic: true as const, content };
}
async function expired() {
  const input = await request();
  const result = await context.pool.query<{ id: string }>(
    `INSERT INTO model_request_content(request_id,run_id,user_id,content_json,created_at,expires_at)
     VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP-INTERVAL '2 days',CURRENT_TIMESTAMP-INTERVAL '1 day') RETURNING id`,
    [input.requestId, input.runId, input.userId, input.content],
  );
  return result.rows[0]!.id;
}
beforeEach(async () => {
  context = await createIntegrationContext();
  await seedDevelopmentBudgetPolicy(context.pool, 'test');
});
afterEach(async () => {
  await context?.close();
});

test('零保留直接返回，不连接数据库或先存再删', async () => {
  const connect = vi.spyOn(context.pool, 'connect');
  try {
    expect(
      await retainModelRequest(
        context.pool,
        { headers: '不会读取或持久化的输入' },
        { environment: 'development' },
      ),
    ).toEqual({ stored: false });
    expect(connect.mock.calls.length).toBe(0);
  } finally {
    connect.mockRestore();
  }
  expect(
    (await context.pool.query('SELECT COUNT(*)::int AS count FROM model_request_content')).rows[0]
      .count,
  ).toBe(0);
});

test('真实环境的正期限拒绝，合成模式也不接受请求头或额外凭据字段', async () => {
  const input = await request();
  await expect(
    retainModelRequest(context.pool, input, { ...policy, environment: 'production' }),
  ).rejects.toMatchObject({ code: 'REQUEST_RETENTION_DISABLED' });
  vi.stubEnv('NODE_ENV', 'production');
  try {
    await expect(retainModelRequest(context.pool, input, policy)).rejects.toMatchObject({
      code: 'REQUEST_RETENTION_DISABLED',
    });
  } finally {
    vi.unstubAllEnvs();
  }
  await expect(
    retainModelRequest(
      context.pool,
      { ...input, headers: { authorization: 'synthetic-credential-marker' } },
      policy,
    ),
  ).rejects.toMatchObject({ code: 'REQUEST_RETENTION_INPUT_INVALID' });
  expect(
    (await context.pool.query('SELECT COUNT(*)::int AS count FROM model_request_content')).rows[0]
      .count,
  ).toBe(0);
});

test('合成请求按身份一次保存，重试不覆盖原文或延长期限', async () => {
  const input = await request();
  const first = await retainModelRequest(context.pool, input, policy);
  expect(first.stored).toBe(true);
  const old = (await context.pool.query('SELECT expires_at FROM model_request_content')).rows[0]
    .expires_at;
  const second = await retainModelRequest(context.pool, input, { ...policy, retentionDays: 30 });
  expect(second).toMatchObject({ stored: true, replayed: true });
  expect(
    (await context.pool.query('SELECT expires_at FROM model_request_content')).rows[0].expires_at,
  ).toEqual(old);
  await expect(
    retainModelRequest(
      context.pool,
      { ...input, content: { messages: [{ role: 'user', content: '另一份内容' }] } },
      policy,
    ),
  ).rejects.toMatchObject({ code: 'REQUEST_RETENTION_CONFLICT' });
  const other = await request();
  await expect(
    retainModelRequest(context.pool, { ...other, runId: input.runId }, policy),
  ).rejects.toMatchObject({ code: 'REQUEST_RETENTION_CONTEXT_MISMATCH' });
});

test('只清理已到期内容，遵守批量并写不含正文的审计，重复清理无副作用', async () => {
  await expired();
  await expired();
  await retainModelRequest(context.pool, await request(), policy);
  expect((await purgeExpiredModelRequests(context.pool, { limit: 1 })).deleted).toBe(1);
  expect((await purgeExpiredModelRequests(context.pool)).deleted).toBe(1);
  expect(await purgeExpiredModelRequests(context.pool)).toEqual({ deleted: 0, batchId: null });
  expect(
    (await context.pool.query('SELECT COUNT(*)::int AS count FROM model_request_content')).rows[0]
      .count,
  ).toBe(1);
  const audit = await context.pool.query(
    "SELECT action,target_id,before_hash FROM audit_log WHERE target_type='model_request_content'",
  );
  expect(audit.rows).toHaveLength(2);
  expect(
    audit.rows.every(
      (row) =>
        row.action === 'model_request.purged_1' && /^[a-f0-9]{64}$/.test(row.before_hash as string),
    ),
  ).toBe(true);
  expect(JSON.stringify(audit.rows)).not.toContain('合成资料正文');
});

test('审计写入失败时删除同事务回滚，不产生无审计的清理', async () => {
  const id = await expired();
  await context.pool
    .query(`CREATE FUNCTION reject_test_cleanup_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action LIKE 'model_request.purged_%' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_test_cleanup BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_test_cleanup_audit();`);
  await expect(purgeExpiredModelRequests(context.pool)).rejects.toMatchObject({
    code: 'REQUEST_RETENTION_FAILED',
  });
  expect(
    (await context.pool.query('SELECT id FROM model_request_content WHERE id=$1', [id])).rowCount,
  ).toBe(1);
});
