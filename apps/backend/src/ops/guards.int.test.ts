import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../db/migrate.js';
import { createTestDatabase } from '../db/test-database.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let client: pg.PoolClient;
let fixture: { user: string; conversation: string; run: string; otherRun: string };
async function denied(statement: string, values: unknown[] = [], code = '42501') {
  await client.query('SAVEPOINT event_guard');
  try {
    await expect(client.query(statement, values)).rejects.toMatchObject({ code });
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT event_guard');
    await client.query('RELEASE SAVEPOINT event_guard');
  }
}
beforeAll(async () => {
  database = await createTestDatabase();
  await migrateDatabase(database.pool);
});
afterAll(async () => {
  await database?.dispose();
});
beforeEach(async () => {
  client = await database.pool.connect();
  await client.query('BEGIN');
  const user = randomUUID(),
    conversation = randomUUID(),
    run = randomUUID(),
    otherRun = randomUUID();
  await client.query(
    'INSERT INTO app_user(id,username,password_hash,display_name) VALUES($1,$2,$3,$4)',
    [user, 'lease_guard', '$argon2id$synthetic-fixture', '租约测试'],
  );
  await client.query('INSERT INTO conversation(id,user_id,title) VALUES($1,$2,$3)', [
    conversation,
    user,
    '测试对话',
  ]);
  for (const current of [run, otherRun])
    await client.query('INSERT INTO run(id,conversation_id,user_id,status) VALUES($1,$2,$3,$4)', [
      current,
      conversation,
      user,
      'running',
    ]);
  fixture = { user, conversation, run, otherRun };
});
afterEach(async () => {
  if (!client) return;
  try {
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});

describe('运行事件与租约SQL保护', () => {
  it('租约代数和序号不可回退，不能抢占有效租约或续期过期代数', async () => {
    const owner = randomUUID(),
      otherOwner = randomUUID();
    await client.query(
      "UPDATE run SET lease_owner=$2,lease_generation=1,lease_expires_at=clock_timestamp()+interval '60 seconds',last_event_seq=1 WHERE id=$1",
      [fixture.run, owner],
    );
    await denied('UPDATE run SET lease_generation=0 WHERE id=$1', [fixture.run]);
    await denied('UPDATE run SET last_event_seq=0 WHERE id=$1', [fixture.run]);
    await denied('UPDATE run SET lease_owner=$2,lease_generation=2 WHERE id=$1', [
      fixture.run,
      otherOwner,
    ]);
    await client.query(
      "UPDATE run SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [fixture.run],
    );
    await denied(
      "UPDATE run SET lease_expires_at=clock_timestamp()+interval '60 seconds' WHERE id=$1",
      [fixture.run],
    );
    await client.query(
      "UPDATE run SET lease_owner=$2,lease_generation=2,lease_expires_at=clock_timestamp()+interval '60 seconds' WHERE id=$1",
      [fixture.run, otherOwner],
    );
    await client.query('UPDATE run SET lease_owner=NULL,lease_expires_at=NULL WHERE id=$1', [
      fixture.run,
    ]);
    await denied(
      "UPDATE run SET lease_owner=$2,lease_expires_at=clock_timestamp()+interval '60 seconds' WHERE id=$1",
      [fixture.run, owner],
    );
    const result = await client.query<{ lease_generation: string }>(
      'SELECT lease_generation FROM run WHERE id=$1',
      [fixture.run],
    );
    expect(result.rows[0]?.lease_generation).toBe('2');
  });
  it('执行事件只追加，同运行序号唯一且没有自由正文列', async () => {
    await client.query('INSERT INTO run_event(run_id,seq,type) VALUES($1,$2,$3)', [
      fixture.run,
      1,
      'run_started',
    ]);
    await denied(
      'INSERT INTO run_event(run_id,seq,type) VALUES($1,$2,$3)',
      [fixture.run, 1, 'run_started'],
      '23505',
    );
    await denied('UPDATE run_event SET type=$2 WHERE run_id=$1', [fixture.run, 'run_failed']);
    await denied('DELETE FROM run_event WHERE run_id=$1', [fixture.run]);
    await denied('TRUNCATE run_event');
    const columns = await client.query<{ column_name: string }>(
      'SELECT column_name FROM information_schema.columns WHERE table_name=$1',
      ['run_event'],
    );
    for (const name of ['message', 'body', 'error', 'arguments', 'content_json', 'data'])
      expect(columns.rows.map((row) => row.column_name)).not.toContain(name);
  });
  it('工具与计量引用必须属于事件的同一运行', async () => {
    const invocation = randomUUID();
    await client.query(
      'INSERT INTO tool_invocation(id,run_id,conversation_id,user_id,call_id,tool_name,tool_version,arguments_hash,effect) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        invocation,
        fixture.run,
        fixture.conversation,
        fixture.user,
        'call-test',
        'mock_read',
        'fixture-v1',
        'a'.repeat(64),
        'read',
      ],
    );
    await denied(
      'INSERT INTO run_event(run_id,seq,type,invocation_id) VALUES($1,$2,$3,$4)',
      [fixture.otherRun, 1, 'tool_started', invocation],
      '23503',
    );
    await client.query('INSERT INTO run_event(run_id,seq,type,invocation_id) VALUES($1,$2,$3,$4)', [
      fixture.run,
      1,
      'tool_started',
      invocation,
    ]);
    await client.query(
      'INSERT INTO budget_policy(id,environment,night_key,run_limit_nano,month_limit_nano,night_limit_nano,max_steps,max_tokens,alert_percent) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      ['default', 'test', 'event-test', '1000000000', '9000000000', '10000000000', 32, 200000, 80],
    );
    const request = randomUUID();
    await client.query(
      "INSERT INTO usage_ledger(request_key,request_fingerprint,policy_id,run_id,conversation_id,user_id,model_id,purpose,month_key,night_key,reserved_nano,estimated_input_tokens,max_output_tokens,price_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,to_char(now() AT TIME ZONE 'Asia/Shanghai','YYYY-MM'),$9,0,0,0,$10)",
      [
        request,
        'b'.repeat(64),
        'default',
        fixture.run,
        fixture.conversation,
        fixture.user,
        'test/model',
        'test',
        'event-test',
        JSON.stringify({
          inputUsdPerMillion: '0',
          cacheReadUsdPerMillion: '0',
          outputUsdPerMillion: '0',
        }),
      ],
    );
    await denied(
      'INSERT INTO run_event(run_id,seq,type,request_id) VALUES($1,$2,$3,$4)',
      [fixture.otherRun, 1, 'model_started', request],
      '23503',
    );
    await client.query('INSERT INTO run_event(run_id,seq,type,request_id) VALUES($1,$2,$3,$4)', [
      fixture.run,
      2,
      'model_started',
      request,
    ]);
  });
  it('通用语义只读角色不能读取执行事件或请求正文', async () => {
    await client.query('SET LOCAL ROLE cert_board_reader');
    await denied('SELECT * FROM run_event');
    await denied('SELECT * FROM model_request_content');
  });
});
