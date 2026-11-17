import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../db/migrate.js';
import { createTestDatabase } from '../db/test-database.js';
import { proposalContentHash } from './content.js';

type Fixture = {
  user: string;
  reviewer: string;
  project: string;
  goal: string;
  conversation: string;
  run: string;
  contact: string;
  session: string;
  proposal: string;
};
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let client: pg.PoolClient;
let fixture: Fixture;
const content = { subject: '测试主题', body: '仅本地记录的虚构正文。' };
const contentHash = proposalContentHash(content);

async function id(statement: string, values: unknown[]) {
  const result = await client.query<{ id: string }>(statement, values);
  const row = result.rows[0];
  if (!row) throw new Error('测试数据未返回编号。');
  return row.id;
}
async function denied(statement: string, values: unknown[] = [], code = '42501') {
  await client.query('SAVEPOINT rejected_outbound_operation');
  try {
    await expect(client.query(statement, values)).rejects.toMatchObject({ code });
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT rejected_outbound_operation');
    await client.query('RELEASE SAVEPOINT rejected_outbound_operation');
  }
}
async function invocation(effect = 'external', operation = 'execute') {
  return id(
    'INSERT INTO tool_invocation(run_id,conversation_id,user_id,call_id,tool_name,tool_version,arguments_hash,effect,operation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
    [
      fixture.run,
      fixture.conversation,
      fixture.user,
      randomUUID(),
      'propose_external',
      'fixture-v1',
      'a'.repeat(64),
      effect,
      operation,
    ],
  );
}
const proposalInsert =
  'INSERT INTO proposal(project_id,goal_id,conversation_id,run_id,invocation_id,proposed_by,contact_id,recipient_version,recipient_name,recipient_address,subject,body,content_hash,data_level) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)';
function proposalValues(invocationId: string, name = '本地测试联系人') {
  return [
    fixture.project,
    fixture.goal,
    fixture.conversation,
    fixture.run,
    invocationId,
    fixture.user,
    fixture.contact,
    1,
    name,
    'local-recipient',
    content.subject,
    content.body,
    contentHash,
    'internal',
  ];
}
const decisionInsert =
  'INSERT INTO decision(proposal_id,actor_user_id,session_id,request_key,source_version,action,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7)';
async function decide(
  action = 'approved',
  requestKey = randomUUID(),
  proposalId = fixture.proposal,
) {
  return id(`${decisionInsert} RETURNING id`, [
    proposalId,
    fixture.user,
    fixture.session,
    requestKey,
    1,
    action,
    contentHash,
  ]);
}
const queueInsert =
  'INSERT INTO outbound_message(proposal_id,decision_id,goal_id,project_id,contact_id,approved_version) VALUES($1,$2,$3,$4,$5,$6)';
function queueValues(decisionId: string, version = 2) {
  return [fixture.proposal, decisionId, fixture.goal, fixture.project, fixture.contact, version];
}
async function approveAndQueue() {
  const decisionId = await decide();
  await client.query('UPDATE proposal SET status=$2,version=version+1 WHERE id=$1', [
    fixture.proposal,
    'approved',
  ]);
  const queue = await id(`${queueInsert} RETURNING id`, queueValues(decisionId));
  return { decisionId, queue };
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
  const user = await id(
    'INSERT INTO app_user(username,password_hash,display_name) VALUES($1,$2,$3) RETURNING id',
    ['proposal_guard_ra', '$argon2id$synthetic-fixture', '测试A'],
  );
  const reviewer = await id(
    'INSERT INTO app_user(username,password_hash,display_name) VALUES($1,$2,$3) RETURNING id',
    ['proposal_guard_rb', '$argon2id$synthetic-fixture', '测试B'],
  );
  const project = await id(
    'INSERT INTO cert_project(name,market,pathway,owner_user_id,reviewer_user_id) VALUES($1,$2,$3,$4,$5) RETURNING id',
    ['提案测试', 'US', '测试', user, reviewer],
  );
  const goal = await id(
    'INSERT INTO goal(project_id,owner_user_id,title,acceptance_criteria) VALUES($1,$2,$3,$4) RETURNING id',
    [project, user, '目标', '人工确认'],
  );
  const conversation = await id(
    'INSERT INTO conversation(project_id,user_id,goal_id,title) VALUES($1,$2,$3,$4) RETURNING id',
    [project, user, goal, '测试对话'],
  );
  const run = await id(
    'INSERT INTO run(conversation_id,user_id,project_id,goal_id,status) VALUES($1,$2,$3,$4,$5) RETURNING id',
    [conversation, user, project, goal, 'running'],
  );
  const contact = await id(
    'INSERT INTO contact(project_id,name,address,source) VALUES($1,$2,$3,$4) RETURNING id',
    [project, '本地测试联系人', 'local-recipient', '合成测试数据'],
  );
  const session = await id(
    'INSERT INTO web_session(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,$4) RETURNING id',
    [user, 'c'.repeat(64), 'd'.repeat(64), new Date(Date.now() + 3_600_000)],
  );
  fixture = { user, reviewer, project, goal, conversation, run, contact, session, proposal: '' };
  fixture.proposal = await id(`${proposalInsert} RETURNING id`, proposalValues(await invocation()));
});
afterEach(async () => {
  if (!client) return;
  try {
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});

describe('提案审批数据库保护', () => {
  it('只有正在执行的external工具能生成提案，读取、撤销、已结束调用都不能借用', async () => {
    await denied(proposalInsert, proposalValues(await invocation('read')));
    await denied(proposalInsert, proposalValues(await invocation('external', 'undo')));
    const previous = await invocation();
    await client.query('UPDATE tool_invocation SET status=$2 WHERE id=$1', [previous, 'completed']);
    await denied(proposalInsert, proposalValues(previous));
    await denied(proposalInsert, proposalValues(await invocation(), '被替换的收件人'));
  });

  it('未审批提案也不能偷偷改正文、hash或收件人，状态操作不影响原内容', async () => {
    await denied('UPDATE proposal SET body=$2,content_hash=$3 WHERE id=$1', [
      fixture.proposal,
      '修改正文',
      'b'.repeat(64),
    ]);
    await denied('UPDATE proposal SET recipient_address=$2 WHERE id=$1', [
      fixture.proposal,
      'another-recipient',
    ]);
    await denied('UPDATE proposal SET proposed_by=$2 WHERE id=$1', [
      fixture.proposal,
      fixture.reviewer,
    ]);
    await client.query('UPDATE proposal SET status=$2,version=version+1 WHERE id=$1', [
      fixture.proposal,
      'expired',
    ]);
    const result = await client.query<{ body: string; content_hash: string }>(
      'SELECT body,content_hash FROM proposal WHERE id=$1',
      [fixture.proposal],
    );
    expect(result.rows[0]).toEqual({ body: content.body, content_hash: contentHash });
  });

  it('审批必须绑定匹配且有效的用户会话、内容哈希及版本', async () => {
    const values = [
      fixture.proposal,
      fixture.user,
      fixture.session,
      randomUUID(),
      1,
      'approved',
      contentHash,
    ];
    await denied(decisionInsert, [
      fixture.proposal,
      fixture.reviewer,
      fixture.session,
      randomUUID(),
      1,
      'approved',
      contentHash,
    ]);
    await denied(decisionInsert, [...values.slice(0, 6), 'b'.repeat(64)], '23514');
    await denied(decisionInsert, [...values.slice(0, 4), 99, 'approved', contentHash], '23514');
    await client.query('UPDATE web_session SET revoked_at=now() WHERE id=$1', [fixture.session]);
    await denied(decisionInsert, values);
  });

  it('每个提案版本只能决定一次，同一用户请求号不能转用于另一个提案', async () => {
    const request = randomUUID();
    await decide('approved', request);
    await denied(
      decisionInsert,
      [fixture.proposal, fixture.user, fixture.session, randomUUID(), 1, 'rejected', contentHash],
      '23505',
    );
    const otherProposal = await id(
      `${proposalInsert} RETURNING id`,
      proposalValues(await invocation()),
    );
    await denied(
      decisionInsert,
      [otherProposal, fixture.user, fixture.session, request, 1, 'approved', contentHash],
      '23505',
    );
  });

  it('人工决定只追加，不能更新或删除', async () => {
    const decisionId = await decide();
    await denied('UPDATE decision SET action=$2 WHERE id=$1', [decisionId, 'rejected']);
    await denied('DELETE FROM decision WHERE id=$1', [decisionId]);
    await denied('TRUNCATE decision CASCADE');
  });

  it('队列必须引用当前批准和正确版本，拒绝被否决的决定、未批准状态及旧版本', async () => {
    const decisionId = await decide();
    await denied(queueInsert, queueValues(decisionId));
    await client.query('UPDATE proposal SET status=$2,version=version+1 WHERE id=$1', [
      fixture.proposal,
      'approved',
    ]);
    await denied(queueInsert, queueValues(decisionId, 1));
    expect(await id(`${queueInsert} RETURNING id`, queueValues(decisionId))).toBeTruthy();
    await denied(queueInsert, queueValues(decisionId), '23505');
    const otherProposal = await id(
      `${proposalInsert} RETURNING id`,
      proposalValues(await invocation()),
    );
    const rejected = await decide('rejected', randomUUID(), otherProposal);
    await client.query('UPDATE proposal SET status=$2,version=version+1 WHERE id=$1', [
      otherProposal,
      'approved',
    ]);
    await denied(queueInsert, [
      otherProposal,
      rejected,
      fixture.goal,
      fixture.project,
      fixture.contact,
      2,
    ]);
  });

  it('取消的历史队列可保留但不能重放，也不能改换批准来源', async () => {
    const { queue } = await approveAndQueue();
    await client.query('UPDATE outbound_message SET status=$2,last_reason=$3 WHERE id=$1', [
      queue,
      'cancelled',
      '恢复后需要重新确认',
    ]);
    await client.query('UPDATE proposal SET status=$2,version=version+1 WHERE id=$1', [
      fixture.proposal,
      'proposed',
    ]);
    await denied('UPDATE outbound_message SET status=$2 WHERE id=$1', [queue, 'queued']);
    await denied('UPDATE outbound_message SET approved_version=approved_version+1 WHERE id=$1', [
      queue,
    ]);
    const row = await client.query<{ status: string; approved_version: number }>(
      'SELECT status,approved_version FROM outbound_message WHERE id=$1',
      [queue],
    );
    expect(row.rows[0]).toEqual({ status: 'cancelled', approved_version: 2 });
  });

  it('本地回执只保存编号，通用只读角色不能读取提案正文与审批队列', async () => {
    const { queue } = await approveAndQueue();
    await client.query('UPDATE proposal SET status=$2,version=version+1 WHERE id=$1', [
      fixture.proposal,
      'executing',
    ]);
    const receipt = randomUUID();
    await client.query(
      'UPDATE outbound_message SET status=$2,attempts=1,receipt_id=$3,processed_at=now() WHERE id=$1',
      [queue, 'done', receipt],
    );
    await client.query('UPDATE proposal SET status=$2,version=version+1 WHERE id=$1', [
      fixture.proposal,
      'done',
    ]);
    await denied('UPDATE outbound_message SET attempts=attempts+1 WHERE id=$1', [queue]);
    const row = await client.query<{ receipt_id: string }>(
      'SELECT receipt_id FROM outbound_message WHERE id=$1',
      [queue],
    );
    expect(row.rows[0]?.receipt_id).toBe(receipt);
    await client.query('SET LOCAL ROLE cert_board_reader');
    for (const statement of [
      'SELECT * FROM proposal',
      'SELECT * FROM decision',
      'SELECT * FROM outbound_message',
    ])
      await denied(statement);
  });
});
