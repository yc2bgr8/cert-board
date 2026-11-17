import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../db/migrate.js';
import { createTestDatabase } from '../db/test-database.js';

type Fixture = {
  owner: string;
  otherUser: string;
  project: string;
  workspace: string;
  version: string;
  conversation: string;
  draft: string;
};
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let client: pg.PoolClient;
let fixture: Fixture;

async function insertedId(statement: string, values: unknown[]) {
  const result = await client.query<{ id: string }>(statement, values);
  const row = result.rows[0];
  if (!row) throw new Error('测试数据未返回编号。');
  return row.id;
}

async function createProject(owner: string, reviewer: string) {
  return insertedId(
    'INSERT INTO cert_project(name,market,pathway,owner_user_id,reviewer_user_id) VALUES($1,$2,$3,$4,$5) RETURNING id',
    ['数据库保护测试', 'US', '测试路径', owner, reviewer],
  );
}

async function createVersion(
  workspaceId: string,
  projectId: string,
  number: number,
  parentVersionId: string | null,
  level = 'internal',
) {
  return insertedId(
    'INSERT INTO workspace_version(workspace_id,project_id,number,parent_version_id,author_type,summary,data_level) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [workspaceId, projectId, number, parentVersionId, 'system', '合成测试版本', level],
  );
}

async function insertFile(versionId: string, path: string, level = 'internal') {
  await client.query(
    'INSERT INTO workspace_file(version_id,path,sha256,byte_size,data_level,media_type) VALUES($1,$2,$3,$4,$5,$6)',
    [versionId, path, 'a'.repeat(64), 3, level, 'text/plain'],
  );
}

async function publish(workspaceId: string, versionId: string, level = 'internal') {
  await client.query(
    'UPDATE workspace SET current_version_id=$2,data_level=$3,version=version+1 WHERE id=$1',
    [workspaceId, versionId, level],
  );
}

async function denied(statement: string, values: unknown[] = [], code = '42501') {
  await client.query('SAVEPOINT rejected_operation');
  try {
    await expect(client.query(statement, values)).rejects.toMatchObject({ code });
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT rejected_operation');
    await client.query('RELEASE SAVEPOINT rejected_operation');
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
  const owner = await insertedId(
    'INSERT INTO app_user(username,password_hash,display_name) VALUES($1,$2,$3) RETURNING id',
    ['guard_ra', '$argon2id$synthetic-fixture', '测试主责'],
  );
  const otherUser = await insertedId(
    'INSERT INTO app_user(username,password_hash,display_name) VALUES($1,$2,$3) RETURNING id',
    ['guard_rb', '$argon2id$synthetic-fixture', '测试复核'],
  );
  const project = await createProject(owner, otherUser);
  const workspace = await insertedId('INSERT INTO workspace(project_id) VALUES($1) RETURNING id', [
    project,
  ]);
  const version = await createVersion(workspace, project, 1, null);
  // 只验证数据库元数据约束；合成哈希不冒充已上传的 MinIO 文件。
  await insertFile(version, '草稿/初版.md');
  await publish(workspace, version);
  const conversation = await insertedId(
    'INSERT INTO conversation(project_id,user_id,title) VALUES($1,$2,$3) RETURNING id',
    [project, owner, '测试对话'],
  );
  const draft = await insertedId(
    'INSERT INTO workspace_draft(workspace_id,project_id,conversation_id,owner_user_id,base_version_id) VALUES($1,$2,$3,$4,$5) RETURNING id',
    [workspace, project, conversation, owner, version],
  );
  fixture = { owner, otherUser, project, workspace, version, conversation, draft };
});
afterEach(async () => {
  if (!client) return;
  try {
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});

describe('工作区数据库安全约束', () => {
  it('发布后的当前版本与历史版本都不能追加文件', async () => {
    const statement =
      'INSERT INTO workspace_file(version_id,path,sha256,byte_size,data_level,media_type) VALUES($1,$2,$3,$4,$5,$6)';
    const values = [
      fixture.version,
      '草稿/非法追加.md',
      'b'.repeat(64),
      5,
      'internal',
      'text/plain',
    ];
    await denied(statement, values);
    const next = await createVersion(fixture.workspace, fixture.project, 2, fixture.version);
    await insertFile(next, '草稿/合法新版.md');
    await publish(fixture.workspace, next);
    await denied(statement, values);
    const result = await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM workspace_file WHERE version_id=$1',
      [fixture.version],
    );
    expect(result.rows[0]?.count).toBe(1);
  });

  it('历史版本和文件拒绝更新、删除，文件拒绝清空，即使修改没有命中行', async () => {
    await denied('UPDATE workspace_version SET summary=$1 WHERE id=$2', ['覆盖', fixture.version]);
    await denied('DELETE FROM workspace_version WHERE FALSE');
    await denied('UPDATE workspace_file SET sha256=$1 WHERE version_id=$2', [
      'b'.repeat(64),
      fixture.version,
    ]);
    await denied('DELETE FROM workspace_file WHERE version_id=$1', [fixture.version]);
    await denied('TRUNCATE workspace_file');
    const row = await client.query<{ summary: string }>(
      'SELECT summary FROM workspace_version WHERE id=$1',
      [fixture.version],
    );
    expect(row.rows[0]?.summary).toBe('合成测试版本');
  });

  it('当前指针不能清空或回退，恢复必须先建立新的版本', async () => {
    await denied('UPDATE workspace SET current_version_id=NULL WHERE id=$1', [fixture.workspace]);
    const next = await createVersion(fixture.workspace, fixture.project, 2, fixture.version);
    await insertFile(next, '草稿/恢复后的新版本.md');
    await publish(fixture.workspace, next);
    await denied('UPDATE workspace SET current_version_id=$2 WHERE id=$1', [
      fixture.workspace,
      fixture.version,
    ]);
    const row = await client.query<{ current_version_id: string }>(
      'SELECT current_version_id FROM workspace WHERE id=$1',
      [fixture.workspace],
    );
    expect(row.rows[0]?.current_version_id).toBe(next);
  });

  it('对话、工作区和草稿的最高级别不能降低，新版本不能低于工作区', async () => {
    await client.query('UPDATE conversation SET max_data_level=$2 WHERE id=$1', [
      fixture.conversation,
      'confidential',
    ]);
    await denied('UPDATE conversation SET max_data_level=$2 WHERE id=$1', [
      fixture.conversation,
      'internal',
    ]);
    await client.query('UPDATE workspace_draft SET data_level=$2 WHERE id=$1', [
      fixture.draft,
      'confidential',
    ]);
    await denied('UPDATE workspace_draft SET data_level=$2 WHERE id=$1', [
      fixture.draft,
      'internal',
    ]);
    await client.query('UPDATE workspace SET data_level=$2 WHERE id=$1', [
      fixture.workspace,
      'confidential',
    ]);
    await denied('UPDATE workspace SET data_level=$2 WHERE id=$1', [fixture.workspace, 'internal']);
    await denied(
      'INSERT INTO workspace_version(workspace_id,project_id,number,author_type,summary,data_level) VALUES($1,$2,$3,$4,$5,$6)',
      [fixture.workspace, fixture.project, 2, 'system', '错误降级版本', 'internal'],
    );
    const next = await createVersion(
      fixture.workspace,
      fixture.project,
      2,
      fixture.version,
      'confidential',
    );
    await insertFile(next, '草稿/保密.md', 'confidential');
    await publish(fixture.workspace, next, 'confidential');
  });

  it('文件级别不能高于版本声明，路径必须已经是NFC规范形式', async () => {
    const next = await createVersion(fixture.workspace, fixture.project, 2, fixture.version);
    const statement =
      'INSERT INTO workspace_file(version_id,path,sha256,byte_size,data_level,media_type) VALUES($1,$2,$3,$4,$5,$6)';
    await denied(statement, [
      next,
      '草稿/保密.md',
      'a'.repeat(64),
      3,
      'confidential',
      'text/plain',
    ]);
    await denied(
      statement,
      [next, '草稿/e\u0301.md', 'a'.repeat(64), 3, 'internal', 'text/plain'],
      '23514',
    );
    await insertFile(next, '草稿/é.md');
  });

  it('组合外键拒绝草稿冒用用户、跨项目、跨工作区基线及快照引用', async () => {
    const secondProject = await createProject(fixture.owner, fixture.otherUser);
    const secondWorkspace = await insertedId(
      'INSERT INTO workspace(project_id) VALUES($1) RETURNING id',
      [secondProject],
    );
    const secondVersion = await createVersion(secondWorkspace, secondProject, 1, null);
    await publish(secondWorkspace, secondVersion);
    const newerOtherVersion = await createVersion(secondWorkspace, secondProject, 2, secondVersion);
    await publish(secondWorkspace, newerOtherVersion);
    const otherConversation = await insertedId(
      'INSERT INTO conversation(project_id,user_id,title) VALUES($1,$2,$3) RETURNING id',
      [secondProject, fixture.owner, '另一项目对话'],
    );
    const ownConversation = await insertedId(
      'INSERT INTO conversation(project_id,user_id,title) VALUES($1,$2,$3) RETURNING id',
      [fixture.project, fixture.owner, '另一私有对话'],
    );
    const draftStatement =
      'INSERT INTO workspace_draft(workspace_id,project_id,conversation_id,owner_user_id,base_version_id) VALUES($1,$2,$3,$4,$5)';
    await denied(
      draftStatement,
      [fixture.workspace, fixture.project, ownConversation, fixture.otherUser, fixture.version],
      '23503',
    );
    await denied(
      draftStatement,
      [fixture.workspace, secondProject, otherConversation, fixture.owner, fixture.version],
      '23503',
    );
    await denied(
      draftStatement,
      [fixture.workspace, fixture.project, ownConversation, fixture.owner, secondVersion],
      '23503',
    );
    await denied(
      'UPDATE workspace SET current_version_id=$2 WHERE id=$1',
      [fixture.workspace, newerOtherVersion],
      '23503',
    );
    await denied(
      'INSERT INTO workspace_version(workspace_id,project_id,number,parent_version_id,author_type,summary,data_level) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        fixture.workspace,
        fixture.project,
        2,
        newerOtherVersion,
        'system',
        '跨工作区父版本',
        'internal',
      ],
      '23503',
    );
    await denied(
      'INSERT INTO workspace_version(workspace_id,project_id,number,author_type,summary,data_level) VALUES($1,$2,$3,$4,$5,$6)',
      [fixture.workspace, secondProject, 2, 'system', '跨项目版本', 'internal'],
      '23503',
    );
    await denied(
      'INSERT INTO submission_snapshot(project_id,sequence,kind,file_manifest,manifest_sha256,created_by,workspace_version_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        fixture.project,
        1,
        'approved_review',
        '[]',
        'a'.repeat(64),
        fixture.owner,
        newerOtherVersion,
      ],
      '23503',
    );
  });

  it('目标与对话必须属于同一项目，项目外对话不能附上项目目标', async () => {
    const otherProject = await createProject(fixture.owner, fixture.otherUser);
    const otherGoal = await insertedId(
      'INSERT INTO goal(project_id,owner_user_id,title,acceptance_criteria) VALUES($1,$2,$3,$4) RETURNING id',
      [otherProject, fixture.owner, '测试目标', '由人核对'],
    );
    const statement =
      'INSERT INTO conversation(project_id,user_id,title,goal_id) VALUES($1,$2,$3,$4)';
    await denied(statement, [fixture.project, fixture.owner, '跨项目目标', otherGoal], '23503');
    await denied(statement, [null, fixture.owner, '项目外目标', otherGoal], '23514');
  });

  it('通用只读角色能读发布工作区元数据，但不能读私有对话和草稿或写业务表', async () => {
    await client.query('SET LOCAL ROLE cert_board_reader');
    const result = await client.query<{ id: string }>('SELECT id FROM workspace WHERE id=$1', [
      fixture.workspace,
    ]);
    expect(result.rows[0]?.id).toBe(fixture.workspace);
    for (const statement of [
      'SELECT * FROM conversation',
      'SELECT * FROM workspace_draft',
      'SELECT * FROM workspace_draft_file',
    ]) {
      await denied(statement);
    }
    await denied('UPDATE workspace SET version=version+1 WHERE id=$1', [fixture.workspace]);
  });
});
