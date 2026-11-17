import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../db/migrate.js';
import { createTestDatabase } from '../db/test-database.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let client: pg.PoolClient;
let actor: { user: string; conversation: string; run: string; month: string };
const night = '2026-11-17-overnight';
const prices = {
  inputUsdPerMillion: '0.15',
  cacheReadUsdPerMillion: '0.016',
  outputUsdPerMillion: '0.47',
};
async function denied(statement: string, values: unknown[] = [], code = '42501') {
  await client.query('SAVEPOINT budget_denied');
  try {
    await expect(client.query(statement, values)).rejects.toMatchObject({ code });
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT budget_denied');
    await client.query('RELEASE SAVEPOINT budget_denied');
  }
}
const insert =
  'INSERT INTO usage_ledger(id,request_key,request_fingerprint,policy_id,run_id,conversation_id,user_id,model_id,purpose,month_key,night_key,reserved_nano,estimated_input_tokens,max_output_tokens,price_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)';
function values() {
  return [
    randomUUID(),
    randomUUID(),
    'a'.repeat(64),
    'default',
    actor.run,
    actor.conversation,
    actor.user,
    'qwen/qwen3.8-flash',
    'agent',
    actor.month,
    night,
    '1000',
    10,
    10,
    JSON.stringify(prices),
  ];
}
async function reserve() {
  const row = values();
  await client.query(insert, row);
  return row[0];
}

beforeAll(async () => {
  database = await createTestDatabase();
  await migrateDatabase(database.pool);
  const result = await database.pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM budget_policy',
  );
  expect(result.rows[0]?.count).toBe(0);
});
afterAll(async () => {
  await database?.dispose();
});
beforeEach(async () => {
  client = await database.pool.connect();
  await client.query('BEGIN');
  await client.query(
    'INSERT INTO budget_policy(id,environment,night_key,run_limit_nano,month_limit_nano,night_limit_nano,max_steps,max_tokens,alert_percent) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    ['default', 'test', night, '1000000000', '9000000000', '10000000000', 32, 200000, 80],
  );
  const user = randomUUID(),
    conversation = randomUUID(),
    run = randomUUID();
  await client.query(
    'INSERT INTO app_user(id,username,password_hash,display_name) VALUES($1,$2,$3,$4)',
    [user, 'budget_guard', '$argon2id$synthetic-fixture', '预算测试'],
  );
  await client.query('INSERT INTO conversation(id,user_id,title) VALUES($1,$2,$3)', [
    conversation,
    user,
    '预算测试',
  ]);
  await client.query('INSERT INTO run(id,conversation_id,user_id,status) VALUES($1,$2,$3,$4)', [
    run,
    conversation,
    user,
    'running',
  ]);
  const result = await client.query<{ month: string }>(
    "SELECT to_char(now() AT TIME ZONE 'Asia/Shanghai','YYYY-MM') AS month",
  );
  actor = { user, conversation, run, month: result.rows[0]!.month };
});
afterEach(async () => {
  if (!client) return;
  try {
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});

describe('预算账本数据库保护', () => {
  it('请求只能预占一次，项目外计量也必须绑定运行本人', async () => {
    const row = values();
    await client.query(insert, row);
    const duplicate = [...row];
    duplicate[0] = randomUUID();
    await denied(insert, duplicate, '23505');
    const wrong = values();
    wrong[6] = randomUUID();
    await denied(insert, wrong, '23503');
  });
  it('不能改写价格、预占或归属，也不能删除记录恢复额度', async () => {
    const id = await reserve();
    await denied('UPDATE usage_ledger SET reserved_nano=0 WHERE id=$1', [id]);
    await denied('UPDATE usage_ledger SET price_snapshot=$2 WHERE id=$1', [
      id,
      JSON.stringify({ ...prices, outputUsdPerMillion: '0' }),
    ]);
    await denied('UPDATE usage_ledger SET month_key=$2 WHERE id=$1', [id, '2099-01']);
    await denied('UPDATE usage_ledger SET night_key=$2 WHERE id=$1', [id, 'new-night']);
    await denied('UPDATE usage_ledger SET project_id=$2 WHERE id=$1', [id, randomUUID()]);
    await denied('DELETE FROM usage_ledger WHERE id=$1', [id]);
    // PR-11新增私有请求/事件外键：普通TRUNCATE先由外键拒绝；CASCADE仍须被不可清空守卫拒绝。
    await denied('TRUNCATE usage_ledger', [], '0A000');
    await denied('TRUNCATE usage_ledger CASCADE');
    await denied('UPDATE budget_policy SET night_key=$1', ['new-night']);
    await denied('UPDATE budget_policy SET environment=$1', ['production']);
    await denied('DELETE FROM budget_policy');
  });
  it('超预占的实际费用仍可如实结算，但不能覆盖已结算金额', async () => {
    const id = await reserve();
    await client.query(
      'UPDATE usage_ledger SET status=$2,actual_nano=$3,input_tokens=10,cache_read_tokens=0,output_tokens=20,settlement_fingerprint=$4 WHERE id=$1',
      [id, 'settled', '2000', 'b'.repeat(64)],
    );
    const record = await client.query<{ reserved_nano: string; actual_nano: string }>(
      'SELECT reserved_nano,actual_nano FROM usage_ledger WHERE id=$1',
      [id],
    );
    expect(record.rows[0]).toEqual({ reserved_nano: '1000', actual_nano: '2000' });
    await denied('UPDATE usage_ledger SET actual_nano=0 WHERE id=$1', [id]);
    await denied('UPDATE usage_ledger SET status=$2 WHERE id=$1', [id, 'reserved']);
  });
  it('unknown保留预占，补齐费用不自动解除政策阻断', async () => {
    const id = await reserve();
    await client.query('UPDATE usage_ledger SET status=$2,reason_code=$3 WHERE id=$1', [
      id,
      'unknown',
      'missing_usage',
    ]);
    await client.query('UPDATE budget_policy SET blocked_reason=$1', ['missing_usage']);
    await denied('UPDATE usage_ledger SET status=$2,actual_nano=0 WHERE id=$1', [id, 'not_sent']);
    await client.query(
      'UPDATE usage_ledger SET status=$2,actual_nano=500,input_tokens=1,cache_read_tokens=0,output_tokens=1,settlement_fingerprint=$3 WHERE id=$1',
      [id, 'settled', 'c'.repeat(64)],
    );
    const result = await client.query<{ blocked_reason: string }>(
      'SELECT blocked_reason FROM budget_policy',
    );
    expect(result.rows[0]?.blocked_reason).toBe('missing_usage');
  });
  it('月份、夜间键、非负费用和结算完整性都受数据库约束', async () => {
    const month = values();
    month[9] = '2099-01';
    await denied(insert, month, '23514');
    const otherNight = values();
    otherNight[10] = 'another-night';
    await denied(insert, otherNight, '23514');
    const negative = values();
    negative[11] = '-1';
    await denied(insert, negative, '23514');
    const id = await reserve();
    await denied(
      'UPDATE usage_ledger SET status=$2,actual_nano=100 WHERE id=$1',
      [id, 'settled'],
      '23514',
    );
  });
  it('通用语义只读角色不能查看预算配置和个人用量', async () => {
    await reserve();
    await client.query('SET LOCAL ROLE cert_board_reader');
    await denied('SELECT * FROM budget_policy');
    await denied('SELECT * FROM usage_ledger');
  });
});
