import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../db/migrate.js';
import { createTestDatabase } from '../db/test-database.js';

type Fixture = {
  user: string;
  otherUser: string;
  project: string;
  goal: string;
  conversation: string;
  run: string;
  invocation: string;
};
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let client: pg.PoolClient;
let fixture: Fixture;
let transactionOpen = false;

async function insertedId(statement: string, values: unknown[]) {
  const result = await client.query<{ id: string }>(statement, values);
  const row = result.rows[0];
  if (!row) throw new Error('测试数据没有返回编号。');
  return row.id;
}

async function denied(statement: string, values: unknown[] = [], code = '42501') {
  await client.query('SAVEPOINT rejected_tool_operation');
  try {
    await expect(client.query(statement, values)).rejects.toMatchObject({ code });
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT rejected_tool_operation');
    await client.query('RELEASE SAVEPOINT rejected_tool_operation');
  }
}

async function createInvocation(runId = fixture.run, callId = 'call-next', operation = 'execute') {
  return insertedId(
    'INSERT INTO tool_invocation(run_id,conversation_id,user_id,call_id,tool_name,tool_version,arguments_hash,effect,operation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
    [
      runId,
      fixture.conversation,
      fixture.user,
      callId,
      'mock_update',
      'fixture-v1',
      'a'.repeat(64),
      'reversible_write',
      operation,
    ],
  );
}

async function pendingUndo() {
  return insertedId(
    'INSERT INTO undo_record(invocation_id,run_id,conversation_id,user_id,tool_name,tool_version,target_type,target_id,before_state,before_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
    [
      fixture.invocation,
      fixture.run,
      fixture.conversation,
      fixture.user,
      'mock_update',
      'fixture-v1',
      'cert_project',
      fixture.project,
      JSON.stringify({ nextAction: null }),
      null,
    ],
  );
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
  transactionOpen = true;
  const user = await insertedId(
    'INSERT INTO app_user(username,password_hash,display_name) VALUES($1,$2,$3) RETURNING id',
    ['tool_guard_ra', '$argon2id$synthetic-fixture', '工具测试A'],
  );
  const otherUser = await insertedId(
    'INSERT INTO app_user(username,password_hash,display_name) VALUES($1,$2,$3) RETURNING id',
    ['tool_guard_rb', '$argon2id$synthetic-fixture', '工具测试B'],
  );
  const project = await insertedId(
    'INSERT INTO cert_project(name,market,pathway,owner_user_id,reviewer_user_id) VALUES($1,$2,$3,$4,$5) RETURNING id',
    ['工具保护测试', 'US', '测试', user, otherUser],
  );
  const goal = await insertedId(
    'INSERT INTO goal(project_id,owner_user_id,title,acceptance_criteria) VALUES($1,$2,$3,$4) RETURNING id',
    [project, user, '工具目标', '人工确认'],
  );
  const conversation = await insertedId(
    'INSERT INTO conversation(project_id,user_id,goal_id,title) VALUES($1,$2,$3,$4) RETURNING id',
    [project, user, goal, '工具测试对话'],
  );
  const run = await insertedId(
    'INSERT INTO run(conversation_id,user_id,project_id,goal_id,status) VALUES($1,$2,$3,$4,$5) RETURNING id',
    [conversation, user, project, goal, 'running'],
  );
  fixture = { user, otherUser, project, goal, conversation, run, invocation: '' };
  fixture.invocation = await createInvocation(run, 'call-original');
});
afterEach(async () => {
  if (!client) return;
  try {
    if (transactionOpen) await client.query('ROLLBACK');
  } finally {
    transactionOpen = false;
    client.release();
  }
});

describe('工具执行数据库安全边界', () => {
  it('运行不能借NULL项目或目标绕过对话上下文，项目外对话仍绑定本人', async () => {
    const statement =
      'INSERT INTO run(conversation_id,user_id,project_id,goal_id) VALUES($1,$2,$3,$4)';
    await denied(
      statement,
      [fixture.conversation, fixture.otherUser, fixture.project, fixture.goal],
      '23503',
    );
    await denied(statement, [fixture.conversation, fixture.user, null, null], '23503');
    await denied(statement, [fixture.conversation, fixture.user, fixture.project, null], '23503');
    const outsideConversation = await insertedId(
      'INSERT INTO conversation(user_id,title) VALUES($1,$2) RETURNING id',
      [fixture.user, '项目外对话'],
    );
    await denied(statement, [outsideConversation, fixture.otherUser, null, null], '23503');
    await denied(statement, [outsideConversation, fixture.user, fixture.project, null], '23503');
    expect(
      await insertedId(`${statement} RETURNING id`, [
        outsideConversation,
        fixture.user,
        null,
        null,
      ]),
    ).toBeTruthy();
  });

  it('既有运行的身份与方向不可改写，关联对话不能换目标', async () => {
    await denied('UPDATE run SET user_id=$2 WHERE id=$1', [fixture.run, fixture.otherUser]);
    await denied('UPDATE run SET goal_id=NULL WHERE id=$1', [fixture.run]);
    await denied('UPDATE run SET direction_version=direction_version+1 WHERE id=$1', [fixture.run]);
    await denied('UPDATE run SET trigger_type=$2 WHERE id=$1', [fixture.run, 'wakeup']);
    await denied('UPDATE conversation SET goal_id=NULL WHERE id=$1', [fixture.conversation]);
    await client.query('UPDATE conversation SET mode=$2 WHERE id=$1', [
      fixture.conversation,
      'read_only',
    ]);
    const result = await client.query<{ mode: string }>(
      'SELECT mode FROM conversation WHERE id=$1',
      [fixture.conversation],
    );
    expect(result.rows[0]?.mode).toBe('read_only');
  });

  it('运行级别只能升高，新运行不能低于对话最高级别', async () => {
    await client.query('UPDATE run SET max_data_level=$2 WHERE id=$1', [
      fixture.run,
      'confidential',
    ]);
    await denied('UPDATE run SET max_data_level=$2 WHERE id=$1', [fixture.run, 'internal']);
    await client.query('UPDATE conversation SET max_data_level=$2 WHERE id=$1', [
      fixture.conversation,
      'confidential',
    ]);
    await denied(
      'INSERT INTO run(conversation_id,user_id,project_id,goal_id,max_data_level) VALUES($1,$2,$3,$4,$5)',
      [fixture.conversation, fixture.user, fixture.project, fixture.goal, 'internal'],
    );
    expect(
      await insertedId(
        'INSERT INTO run(conversation_id,user_id,project_id,goal_id,max_data_level) VALUES($1,$2,$3,$4,$5) RETURNING id',
        [fixture.conversation, fixture.user, fixture.project, fixture.goal, 'confidential'],
      ),
    ).toBeTruthy();
  });

  it('幂等callId唯一，不能改写参数摘要或把execute变成undo重用', async () => {
    await denied(
      'INSERT INTO tool_invocation(run_id,conversation_id,user_id,call_id,tool_name,tool_version,arguments_hash,effect,operation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        fixture.run,
        fixture.conversation,
        fixture.user,
        'call-original',
        'mock_update',
        'fixture-v1',
        'b'.repeat(64),
        'reversible_write',
        'undo',
      ],
      '23505',
    );
    await denied('UPDATE tool_invocation SET arguments_hash=$2 WHERE id=$1', [
      fixture.invocation,
      'b'.repeat(64),
    ]);
    await denied('UPDATE tool_invocation SET operation=$2 WHERE id=$1', [
      fixture.invocation,
      'undo',
    ]);
    await denied('DELETE FROM tool_invocation WHERE id=$1', [fixture.invocation]);
    await client.query('UPDATE tool_invocation SET status=$2 WHERE id=$1', [
      fixture.invocation,
      'completed',
    ]);
  });

  it('私有正文必须绑定同一调用、对话和用户，返回内容不能被覆盖', async () => {
    const statement =
      'INSERT INTO conversation_tool_result(invocation_id,conversation_id,user_id,content_json,data_level) VALUES($1,$2,$3,$4,$5)';
    const content = JSON.stringify({ data: { text: '私有正文示例' }, dataLevel: 'internal' });
    await denied(
      statement,
      [fixture.invocation, fixture.conversation, fixture.otherUser, content, 'internal'],
      '23503',
    );
    await client.query(statement, [
      fixture.invocation,
      fixture.conversation,
      fixture.user,
      content,
      'internal',
    ]);
    await denied('UPDATE conversation_tool_result SET content_json=$2 WHERE invocation_id=$1', [
      fixture.invocation,
      JSON.stringify({ data: '篡改' }),
    ]);
    await denied(
      statement,
      [fixture.invocation, fixture.conversation, fixture.user, content, 'internal'],
      '23505',
    );
  });

  it('原值先进入pending，成功后须补版本；原值与版本凭据不能改写', async () => {
    const undo = await pendingUndo();
    await denied('UPDATE undo_record SET status=$2 WHERE id=$1', [undo, 'available'], '23514');
    await denied('UPDATE undo_record SET before_state=$2 WHERE id=$1', [
      undo,
      JSON.stringify({ nextAction: '替换原值' }),
    ]);
    await client.query('UPDATE undo_record SET status=$2,after_version=$3 WHERE id=$1', [
      undo,
      'available',
      '2',
    ]);
    await client.query('SET CONSTRAINTS undo_record_ready_at_commit IMMEDIATE');
    await denied('UPDATE undo_record SET after_version=$2 WHERE id=$1', [undo, '99']);
    await denied('DELETE FROM undo_record WHERE id=$1', [undo]);
    await denied('UPDATE undo_record SET status=$2 WHERE id=$1', [undo, 'undone'], '23514');
  });

  it('不能提交残留pending，失败提交会原子回滚调用和撤销记录', async () => {
    await pendingUndo();
    await client.query('UPDATE cert_project SET next_action=$2 WHERE id=$1', [
      fixture.project,
      '尚未配对撤销版本的写入',
    ]);
    await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
    await client.query('ROLLBACK');
    transactionOpen = false;
    const result = await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM tool_invocation WHERE id=$1',
      [fixture.invocation],
    );
    expect(result.rows[0]?.count).toBe(0);
    const undo = await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM undo_record WHERE invocation_id=$1',
      [fixture.invocation],
    );
    expect(undo.rows[0]?.count).toBe(0);
  });

  it('同一对话的新运行可登记撤销调用，原记录保留最初运行与完整撤销证据', async () => {
    const undo = await pendingUndo();
    await client.query('UPDATE undo_record SET status=$2,after_version=$3 WHERE id=$1', [
      undo,
      'available',
      'after-token',
    ]);
    const nextRun = await insertedId(
      'INSERT INTO run(conversation_id,user_id,project_id,goal_id,status) VALUES($1,$2,$3,$4,$5) RETURNING id',
      [fixture.conversation, fixture.user, fixture.project, fixture.goal, 'running'],
    );
    expect(await createInvocation(nextRun, 'call-undo', 'undo')).toBeTruthy();
    await client.query(
      'UPDATE undo_record SET status=$2,undone_version=$3,undone_at=now(),undone_by=$4 WHERE id=$1',
      [undo, 'undone', 'restored-token', fixture.user],
    );
    const result = await client.query<{ run_id: string; status: string; undone_version: string }>(
      'SELECT run_id,status,undone_version FROM undo_record WHERE id=$1',
      [undo],
    );
    expect(result.rows[0]).toEqual({
      run_id: fixture.run,
      status: 'undone',
      undone_version: 'restored-token',
    });
    await client.query('SET CONSTRAINTS undo_record_ready_at_commit IMMEDIATE');
    await denied(
      'UPDATE undo_record SET status=$2,undone_version=NULL,undone_at=NULL,undone_by=NULL WHERE id=$1',
      [undo, 'available'],
    );
  });

  it('调用元数据没有原始参数或正文列，通用只读角色不能读取四类执行私有表', async () => {
    const columns = await client.query<{ column_name: string }>(
      'SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2',
      ['public', 'tool_invocation'],
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names).toContain('arguments_hash');
    for (const name of [
      'raw_arguments',
      'arguments_json',
      'arguments',
      'content_json',
      'before_state',
      'credentials',
    ])
      expect(names).not.toContain(name);
    await client.query('SET LOCAL ROLE cert_board_reader');
    for (const statement of [
      'SELECT * FROM run',
      'SELECT * FROM tool_invocation',
      'SELECT * FROM conversation_tool_result',
      'SELECT * FROM undo_record',
    ])
      await denied(statement);
  });
});
