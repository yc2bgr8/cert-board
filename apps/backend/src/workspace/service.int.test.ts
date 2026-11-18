import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { agentIdentitySchema, type AgentIdentity } from '@cert-board/shared';
import { createTestDatabase } from '../db/test-database.js';
import { migrateDatabase } from '../db/migrate.js';
import { seedDevelopmentAccounts } from '../db/seed.js';
import { createProject } from '../projects/service.js';
import { createTestBlobStore } from '../documents/test-blob-store.js';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import {
  createDraft,
  getDraft,
  getWorkspaceByProject,
  listDraftFiles,
  listVersionFiles,
  listVersions,
  readDraftFile,
  readVersionFile,
  rebaseDraft,
  restoreVersion,
  saveDraft,
  writeDraftFile,
} from './service.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let blobs: Awaited<ReturnType<typeof createTestBlobStore>>;
let ra: AgentIdentity;
let rb: AgentIdentity;
let projectId: string;
let workspaceId: string;
let initialVersionId: string;
let sequence = 0;
const initialDecisions = '# 决定记录\n';
const initialReport = '初始检查记录\n';

async function conversation(identity: AgentIdentity, permission_mode = 'ask', project = projectId) {
  const result = await database.pool.query<{ id: string }>(
    'INSERT INTO conversation(project_id,user_id,title,permission_mode) VALUES($1,$2,$3,$4) RETURNING id',
    [project, identity.userId, '独立工作区测试对话', permission_mode],
  );
  return result.rows[0]!.id;
}
async function draft(identity = ra) {
  return createDraft(database.pool, identity, await conversation(identity));
}
async function read(draftId: string, path: string, identity = ra) {
  return readDraftFile(database.pool, blobs.store, identity, draftId, path);
}

beforeAll(async () => {
  database = await createTestDatabase();
  await migrateDatabase(database.pool);
  const password = (role: string) => ['workspace', 'integration', role, 'example'].join('-');
  await seedDevelopmentAccounts(database.pool, {
    NODE_ENV: 'test',
    DEV_ZHANGSAN_PASSWORD: password('zhangsan'),
    DEV_WANGMIN_PASSWORD: password('wangmin'),
    DEV_ADMIN_PASSWORD: password('admin'),
  });
  const users = await database.pool.query(
    "SELECT id,username,display_name FROM app_user WHERE username IN ('zhangsan','wangmin')",
  );
  const identity = (username: string) => {
    const user = users.rows.find((entry) => entry.username === username);
    return agentIdentitySchema.parse({
      kind: 'agent',
      userId: user.id,
      username,
      displayName: user.display_name,
      isDevelopment: true,
      runId: randomUUID(),
      isManagement: false,
    });
  };
  ra = identity('zhangsan');
  rb = identity('wangmin');
  blobs = await createTestBlobStore();
});
beforeEach(async () => {
  projectId = (
    await createProject(database.pool, ra, {
      name: `工作区独立测试${++sequence}`,
      projectType: 'registration',
      market: 'US',
      pathway: '510(k)',
      reviewerUserId: rb.userId,
    })
  ).id;
  const files = [];
  for (const [path, content] of [
    ['AGENTS.md', '# 项目说明\n'],
    ['决定记录.md', initialDecisions],
    ['草稿/检查记录.md', initialReport],
  ]) {
    const stored = await blobs.store.put(Buffer.from(content!, 'utf8'));
    files.push({ path: path!, ...stored });
  }
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    workspaceId = (
      await client.query<{ id: string }>(
        'INSERT INTO workspace(project_id) VALUES($1) RETURNING id',
        [projectId],
      )
    ).rows[0]!.id;
    initialVersionId = (
      await client.query<{ id: string }>(
        "INSERT INTO workspace_version(workspace_id,project_id,number,author_type,summary,data_level) VALUES($1,$2,1,'system','测试初始化','internal') RETURNING id",
        [workspaceId, projectId],
      )
    ).rows[0]!.id;
    for (const file of files)
      await client.query(
        "INSERT INTO workspace_file(version_id,path,sha256,byte_size,data_level,media_type) VALUES($1,$2,$3,$4,'internal','text/markdown; charset=utf-8')",
        [initialVersionId, file.path, file.sha256, file.byteSize],
      );
    await client.query('UPDATE workspace SET current_version_id=$1 WHERE id=$2', [
      initialVersionId,
      workspaceId,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});
afterAll(async () => {
  const results = await Promise.allSettled([blobs?.dispose(), database?.dispose()]);
  const failed = results.find((entry) => entry.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
});

test('工作副本只保存overlay，同一会话重复创建幂等，两个副本互不影响', async () => {
  const convo = await conversation(ra);
  const first = await createDraft(database.pool, ra, convo);
  expect((await createDraft(database.pool, ra, convo)).id).toBe(first.id);
  expect(
    (await database.pool.query('SELECT id FROM workspace_draft_file WHERE draft_id=$1', [first.id]))
      .rowCount,
  ).toBe(0);
  const second = await draft();
  const original = await read(first.id, '草稿/检查记录.md');
  const edited = await writeDraftFile(database.pool, blobs.store, ra, first.id, {
    path: '草稿/检查记录.md',
    content: '仅第一份副本的修改',
    expectedSha256: original.sha256,
  });
  expect(edited.draft.version).toBe(first.version + 1);
  expect((await read(first.id, '草稿/检查记录.md')).text).toBe('仅第一份副本的修改');
  expect((await read(second.id, '草稿/检查记录.md')).text).toBe(initialReport);
  expect(
    (await readVersionFile(database.pool, blobs.store, ra, initialVersionId, '草稿/检查记录.md'))
      .text,
  ).toBe(initialReport);
  expect(
    (await database.pool.query('SELECT id FROM workspace_draft_file WHERE draft_id=$1', [first.id]))
      .rowCount,
  ).toBe(1);
});

test('文件CAS检查当前哈希，并发同文件仅一次写入成功', async () => {
  const current = await draft();
  const file = await read(current.id, '草稿/检查记录.md');
  const outcomes = await Promise.allSettled([
    writeDraftFile(database.pool, blobs.store, ra, current.id, {
      path: file.path,
      content: '修改甲',
      expectedSha256: file.sha256,
    }),
    writeDraftFile(database.pool, blobs.store, ra, current.id, {
      path: file.path,
      content: '修改乙',
      expectedSha256: file.sha256,
    }),
  ]);
  expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
  const failure = outcomes.find((item) => item.status === 'rejected');
  expect(failure?.status === 'rejected' && failure.reason.code === 'WORKSPACE_FILE_CONFLICT').toBe(
    true,
  );
  await expect(
    writeDraftFile(database.pool, blobs.store, ra, current.id, {
      path: file.path,
      content: '错误的新文件声明',
      expectedSha256: null,
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  await expect(
    writeDraftFile(database.pool, blobs.store, ra, current.id, {
      path: '../.env.local',
      content: '禁止路径',
      expectedSha256: null,
    }),
  ).rejects.toMatchObject({ statusCode: 400 });
});

test('同基础版本的两个会话只能一个保存，冲突包含已保存文件且保留失败副本', async () => {
  const first = await draft(),
    second = await draft();
  await writeDraftFile(database.pool, blobs.store, ra, first.id, {
    path: '草稿/甲.md',
    content: '第一份内容',
    expectedSha256: null,
  });
  await writeDraftFile(database.pool, blobs.store, ra, second.id, {
    path: '草稿/乙.md',
    content: '第二份内容',
    expectedSha256: null,
  });
  const outcomes = await Promise.allSettled([
    saveDraft(database.pool, blobs.store, ra, first.id, '保存第一份副本'),
    saveDraft(database.pool, blobs.store, ra, second.id, '保存第二份副本'),
  ]);
  expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
  const success = outcomes.find((item) => item.status === 'fulfilled');
  if (success?.status !== 'fulfilled') throw new Error('没有成功版本');
  const winnerPath = success.value.draft.id === first.id ? '草稿/甲.md' : '草稿/乙.md';
  const loserPath = winnerPath === '草稿/甲.md' ? '草稿/乙.md' : '草稿/甲.md';
  const loser = success.value.draft.id === first.id ? second : first;
  const failure = outcomes.find((item) => item.status === 'rejected');
  expect(failure?.status === 'rejected' && failure.reason.statusCode === 409).toBe(true);
  if (failure?.status === 'rejected')
    expect(failure.reason.details).toEqual({ changedPaths: [winnerPath], truncated: false });
  expect(success.value.version.number).toBe(2);
  expect((await getWorkspaceByProject(database.pool, ra, projectId)).currentVersionId).toBe(
    success.value.version.id,
  );
  const published = await listVersionFiles(database.pool, ra, success.value.version.id);
  expect(published.items.some((file) => file.path === winnerPath)).toBe(true);
  expect(published.items.some((file) => file.path === loserPath)).toBe(false);
  expect(
    (await listDraftFiles(database.pool, ra, loser.id)).items.some(
      (file) => file.path === loserPath,
    ),
  ).toBe(true);
  expect((await listVersions(database.pool, ra, workspaceId)).items).toHaveLength(2);
});

test('非重叠保存冲突可显式重基，保留双方文件后再保存成功', async () => {
  const first = await draft(),
    second = await draft();
  await writeDraftFile(database.pool, blobs.store, ra, first.id, {
    path: '草稿/甲.md',
    content: '甲的改动',
    expectedSha256: null,
  });
  const own = await writeDraftFile(database.pool, blobs.store, ra, second.id, {
    path: '草稿/乙.md',
    content: '乙的改动',
    expectedSha256: null,
  });
  const saved = await saveDraft(database.pool, blobs.store, ra, first.id, '先保存甲');
  await expect(
    saveDraft(database.pool, blobs.store, ra, second.id, '乙遇到冲突'),
  ).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' });
  expect((await createDraft(database.pool, ra, second.conversationId)).baseVersionId).toBe(
    initialVersionId,
  );
  const rebased = await rebaseDraft(database.pool, blobs.store, ra, second.id, {
    expectedDraftVersion: own.draft.version,
    expectedCurrentVersionId: saved.version.id,
    resolutions: [],
  });
  expect(rebased.draft.baseVersionId).toBe(saved.version.id);
  expect(rebased.draft.version).toBe(own.draft.version + 1);
  expect((await read(second.id, '草稿/甲.md')).text).toBe('甲的改动');
  expect((await read(second.id, '草稿/乙.md')).text).toBe('乙的改动');
  expect(
    (
      await database.pool.query('SELECT path FROM workspace_draft_file WHERE draft_id=$1', [
        second.id,
      ])
    ).rows.map((row) => row.path),
  ).toEqual(['草稿/乙.md']);
  const merged = await saveDraft(database.pool, blobs.store, ra, second.id, '显式整合后保存');
  expect(merged.version.number).toBe(3);
  const files = (await listVersionFiles(database.pool, ra, merged.version.id)).items.map(
    (file) => file.path,
  );
  expect(files).toContain('草稿/甲.md');
  expect(files).toContain('草稿/乙.md');
  const audits = await database.pool.query(
    "SELECT actor_kind FROM audit_log WHERE action='workspace.rebased' AND target_id=$1",
    [second.id],
  );
  expect(audits.rows).toEqual([{ actor_kind: 'agent' }]);
});

test('同路径冲突必须先手动合并并显式确认实际双方哈希，缺失或过期确认拒绝', async () => {
  const first = await draft(),
    second = await draft();
  const original = await read(first.id, '草稿/检查记录.md');
  await writeDraftFile(database.pool, blobs.store, ra, first.id, {
    path: original.path,
    content: '甲版本\n',
    expectedSha256: original.sha256,
  });
  const own = await writeDraftFile(database.pool, blobs.store, ra, second.id, {
    path: original.path,
    content: '乙版本\n',
    expectedSha256: original.sha256,
  });
  const saved = await saveDraft(database.pool, blobs.store, ra, first.id, '甲更新同一文件');
  const target = await readVersionFile(
    database.pool,
    blobs.store,
    ra,
    saved.version.id,
    original.path,
  );
  const request = {
    expectedDraftVersion: own.draft.version,
    expectedCurrentVersionId: saved.version.id,
    resolutions: [],
  };
  await expect(
    rebaseDraft(database.pool, blobs.store, ra, second.id, request),
  ).rejects.toMatchObject({
    statusCode: 409,
    details: { changedPaths: [original.path], truncated: false },
  });
  expect((await read(second.id, original.path)).text).toBe('乙版本\n');
  const combined = await writeDraftFile(database.pool, blobs.store, ra, second.id, {
    path: original.path,
    content: '甲版本\n乙版本\n',
    expectedSha256: own.file.sha256,
  });
  const confirmed = {
    expectedDraftVersion: combined.draft.version,
    expectedCurrentVersionId: saved.version.id,
    resolutions: [
      {
        path: original.path,
        expectedCurrentSha256: target.sha256,
        expectedDraftSha256: combined.file.sha256,
      },
    ],
  };
  for (const field of ['expectedCurrentSha256', 'expectedDraftSha256'] as const) {
    await expect(
      rebaseDraft(database.pool, blobs.store, ra, second.id, {
        ...confirmed,
        resolutions: [{ ...confirmed.resolutions[0], [field]: 'a'.repeat(64) }],
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  }
  await expect(
    rebaseDraft(database.pool, blobs.store, ra, second.id, {
      ...confirmed,
      expectedDraftVersion: own.draft.version,
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  await expect(
    rebaseDraft(database.pool, blobs.store, ra, second.id, {
      ...confirmed,
      expectedCurrentVersionId: initialVersionId,
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  const rebased = await rebaseDraft(database.pool, blobs.store, ra, second.id, confirmed);
  expect(rebased.draft.baseVersionId).toBe(saved.version.id);
  const merged = await saveDraft(database.pool, blobs.store, ra, second.id, '确认手动合并');
  expect(
    (await readVersionFile(database.pool, blobs.store, ra, merged.version.id, original.path)).text,
  ).toBe('甲版本\n乙版本\n');
  expect(
    (await readVersionFile(database.pool, blobs.store, ra, saved.version.id, original.path)).text,
  ).toBe('甲版本\n');
});

test('重基移除与新基线相同的overlay，并传播会话更高级别', async () => {
  const first = await draft(),
    second = await draft();
  const original = await read(first.id, '草稿/检查记录.md');
  await writeDraftFile(database.pool, blobs.store, ra, first.id, {
    path: original.path,
    content: '相同的修改',
    expectedSha256: original.sha256,
  });
  const own = await writeDraftFile(database.pool, blobs.store, ra, second.id, {
    path: original.path,
    content: '相同的修改',
    expectedSha256: original.sha256,
  });
  const saved = await saveDraft(database.pool, blobs.store, ra, first.id, '发布相同修改');
  await database.pool.query("UPDATE conversation SET max_data_level='confidential' WHERE id=$1", [
    second.conversationId,
  ]);
  const rebased = await rebaseDraft(database.pool, blobs.store, ra, second.id, {
    expectedDraftVersion: own.draft.version,
    expectedCurrentVersionId: saved.version.id,
  });
  expect(rebased.draft.dataLevel).toBe('confidential');
  expect((await getWorkspaceByProject(database.pool, ra, projectId)).dataLevel).toBe(
    'confidential',
  );
  expect(
    (
      await database.pool.query('SELECT path FROM workspace_draft_file WHERE draft_id=$1', [
        second.id,
      ])
    ).rowCount,
  ).toBe(0);
  expect((await read(second.id, original.path)).dataLevel).toBe('confidential');
});

test('重基后的联合清单超过10000项时拒绝，保留旧基线和私有overlay', async () => {
  const contents = new Map<string, Buffer>();
  const memoryStore: DocumentBlobStore = {
    async put(content) {
      const sha256 = createHash('sha256').update(content).digest('hex');
      contents.set(sha256, content);
      return { sha256, byteSize: content.byteLength };
    },
    async get(sha256) {
      const content = contents.get(sha256);
      if (!content) throw new Error('缺少合成测试内容');
      return content;
    },
  };
  for (const file of (await listVersionFiles(database.pool, ra, initialVersionId)).items) {
    contents.set(file.sha256, await blobs.store.get(file.sha256));
  }
  const shared = await memoryStore.put(Buffer.from('大量元数据复用同一份合成内容\n', 'utf8'));
  const client = await database.pool.connect();
  let baseVersionId: string;
  try {
    await client.query('BEGIN');
    baseVersionId = (
      await client.query<{ id: string }>(
        "INSERT INTO workspace_version(workspace_id,project_id,number,parent_version_id,author_type,summary,data_level) VALUES($1,$2,2,$3,'system','联合清单上限合成测试','internal') RETURNING id",
        [workspaceId, projectId, initialVersionId],
      )
    ).rows[0]!.id;
    await client.query(
      'INSERT INTO workspace_file(version_id,path,sha256,byte_size,data_level,media_type) SELECT $1,path,sha256,byte_size,data_level,media_type FROM workspace_file WHERE version_id=$2',
      [baseVersionId, initialVersionId],
    );
    // 只在本测试随机创建的临时库生成元数据，9996项共用一个内存blob。
    await client.query(
      "INSERT INTO workspace_file(version_id,path,sha256,byte_size,data_level,media_type) SELECT $1,'压力/文件-'||lpad(n::text,5,'0')||'.md',$2,$3,'internal','text/markdown; charset=utf-8' FROM generate_series(1,9996) n",
      [baseVersionId, shared.sha256, shared.byteSize],
    );
    await client.query('UPDATE workspace SET current_version_id=$1 WHERE id=$2', [
      baseVersionId,
      workspaceId,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const first = await draft(),
    second = await draft();
  await writeDraftFile(database.pool, memoryStore, ra, first.id, {
    path: '草稿/甲新增.md',
    content: '甲新增',
    expectedSha256: null,
  });
  const own = await writeDraftFile(database.pool, memoryStore, ra, second.id, {
    path: '草稿/乙新增.md',
    content: '乙新增',
    expectedSha256: null,
  });
  const saved = await saveDraft(database.pool, memoryStore, ra, first.id, '甲保存至10000项');
  expect(
    (
      await database.pool.query(
        'SELECT count(*)::integer AS count FROM workspace_file WHERE version_id=$1',
        [saved.version.id],
      )
    ).rows[0]?.count,
  ).toBe(10000);
  await expect(
    rebaseDraft(database.pool, memoryStore, ra, second.id, {
      expectedDraftVersion: own.draft.version,
      expectedCurrentVersionId: saved.version.id,
    }),
  ).rejects.toMatchObject({ statusCode: 413, code: 'WORKSPACE_FILE_LIMIT' });
  const unchanged = await getDraft(database.pool, ra, second.id);
  expect(unchanged.baseVersionId).toBe(baseVersionId);
  expect(unchanged.version).toBe(own.draft.version);
  expect(
    (
      await database.pool.query('SELECT path FROM workspace_draft_file WHERE draft_id=$1', [
        second.id,
      ])
    ).rows,
  ).toEqual([{ path: '草稿/乙新增.md' }]);
  expect((await getWorkspaceByProject(database.pool, ra, projectId)).currentVersionId).toBe(
    saved.version.id,
  );
});

test('分叉的决定记录不自动合并，显式确认也不能丢当前历史', async () => {
  const first = await draft(),
    second = await draft();
  const original = await read(first.id, '决定记录.md');
  const firstText = initialDecisions + '甲的决定\n',
    secondText = initialDecisions + '乙的未保存决定\n';
  const firstWrite = await writeDraftFile(database.pool, blobs.store, ra, first.id, {
    path: original.path,
    content: firstText,
    expectedSha256: original.sha256,
  });
  const own = await writeDraftFile(database.pool, blobs.store, ra, second.id, {
    path: original.path,
    content: secondText,
    expectedSha256: original.sha256,
  });
  const saved = await saveDraft(database.pool, blobs.store, ra, first.id, '先保存甲的决定');
  await expect(
    rebaseDraft(database.pool, blobs.store, ra, second.id, {
      expectedDraftVersion: own.draft.version,
      expectedCurrentVersionId: saved.version.id,
      resolutions: [
        {
          path: original.path,
          expectedCurrentSha256: firstWrite.file.sha256,
          expectedDraftSha256: own.file.sha256,
        },
      ],
    }),
  ).rejects.toMatchObject({ statusCode: 409, code: 'WORKSPACE_DECISIONS_REBASE_CONFLICT' });
  expect((await read(second.id, original.path)).text).toBe(secondText);
  expect(
    (await readVersionFile(database.pool, blobs.store, ra, saved.version.id, original.path)).text,
  ).toBe(firstText);
  const fresh = await draft();
  const latest = await read(fresh.id, original.path);
  await writeDraftFile(database.pool, blobs.store, ra, fresh.id, {
    path: original.path,
    content: firstText + '乙的未保存决定\n',
    expectedSha256: latest.sha256,
  });
  const completed = await saveDraft(
    database.pool,
    blobs.store,
    ra,
    fresh.id,
    '从最新基线追加待合并决定',
  );
  expect(
    (await readVersionFile(database.pool, blobs.store, ra, completed.version.id, original.path))
      .text,
  ).toBe(firstText + '乙的未保存决定\n');
});

test('其他成员不能读写私有副本，已发布版本共享且跨项目组合外键仍隔离', async () => {
  const own = await draft();
  await expect(read(own.id, 'AGENTS.md', rb)).rejects.toMatchObject({ statusCode: 404 });
  await expect(listDraftFiles(database.pool, rb, own.id)).rejects.toMatchObject({
    statusCode: 404,
  });
  await expect(
    rebaseDraft(database.pool, blobs.store, rb, own.id, {
      expectedDraftVersion: own.version,
      expectedCurrentVersionId: initialVersionId,
    }),
  ).rejects.toMatchObject({ statusCode: 404 });
  await expect(
    writeDraftFile(database.pool, blobs.store, rb, own.id, {
      path: '草稿/越权.md',
      content: '越权',
      expectedSha256: null,
    }),
  ).rejects.toMatchObject({ statusCode: 404 });
  expect((await read(own.id, 'AGENTS.md', ra)).text).toBe('# 项目说明\n');
  expect(
    (await readVersionFile(database.pool, blobs.store, rb, initialVersionId, 'AGENTS.md')).text,
  ).toBe('# 项目说明\n');
  await database.pool.query("UPDATE app_user SET status='disabled' WHERE id=$1", [ra.userId]);
  try {
    await expect(read(own.id, 'AGENTS.md', ra)).rejects.toMatchObject({ statusCode: 404 });
  } finally {
    await database.pool.query("UPDATE app_user SET status='active' WHERE id=$1", [ra.userId]);
  }
  const other = (
    await createProject(database.pool, ra, {
      name: '跨项目对话测试',
      projectType: 'registration',
      market: 'US',
      pathway: '510(k)',
      reviewerUserId: rb.userId,
    })
  ).id;
  const otherConversation = await conversation(ra, 'ask', other);
  await expect(
    database.pool.query(
      'INSERT INTO workspace_draft(workspace_id,project_id,conversation_id,owner_user_id,base_version_id) VALUES($1,$2,$3,$4,$5)',
      [workspaceId, projectId, otherConversation, ra.userId, initialVersionId],
    ),
  ).rejects.toMatchObject({ code: '23503' });
  const anotherOwnConversation = await conversation(ra);
  await expect(createDraft(database.pool, rb, anotherOwnConversation)).rejects.toMatchObject({
    statusCode: 404,
  });
  await expect(
    database.pool.query(
      'INSERT INTO workspace_draft(workspace_id,project_id,conversation_id,owner_user_id,base_version_id) VALUES($1,$2,$3,$4,$5)',
      [workspaceId, projectId, anotherOwnConversation, rb.userId, initialVersionId],
    ),
  ).rejects.toMatchObject({ code: '23503' });
});

test('只读或归档会话强行创建、写入、保存和恢复均被拒绝', async () => {
  expect((await createDraft(database.pool, ra, await conversation(ra, 'full'))).ownerUserId).toBe(
    ra.userId,
  );
  await expect(
    createDraft(database.pool, ra, await conversation(ra, 'read_only')),
  ).rejects.toMatchObject({ statusCode: 403, code: 'WORKSPACE_READ_ONLY' });
  const current = await draft();
  await database.pool.query("UPDATE conversation SET permission_mode='full' WHERE id=$1", [
    current.conversationId,
  ]);
  const permitted = await writeDraftFile(database.pool, blobs.store, ra, current.id, {
    path: '草稿/完全允许.md',
    content: '完整模式可写本人的工作副本',
    expectedSha256: null,
  });
  expect(permitted.file.path).toBe('草稿/完全允许.md');
  await database.pool.query("UPDATE conversation SET permission_mode='read_only' WHERE id=$1", [
    current.conversationId,
  ]);
  expect((await read(current.id, 'AGENTS.md')).text).toBe('# 项目说明\n');
  await expect(
    writeDraftFile(database.pool, blobs.store, ra, current.id, {
      path: '草稿/只读.md',
      content: '应拒绝',
      expectedSha256: null,
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    saveDraft(database.pool, blobs.store, ra, current.id, '只读保存'),
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    restoreVersion(database.pool, blobs.store, ra, current.id, initialVersionId, '只读恢复'),
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    rebaseDraft(database.pool, blobs.store, ra, current.id, {
      expectedDraftVersion: current.version,
      expectedCurrentVersionId: initialVersionId,
    }),
  ).rejects.toMatchObject({ statusCode: 403, code: 'WORKSPACE_READ_ONLY' });
  await database.pool.query(
    "UPDATE conversation SET permission_mode='ask',status='archived' WHERE id=$1",
    [current.conversationId],
  );
  await expect(
    saveDraft(database.pool, blobs.store, ra, current.id, '归档保存'),
  ).rejects.toMatchObject({ code: 'WORKSPACE_CONVERSATION_INACTIVE' });
});

test('保密级别从最新会话传播，恢复旧版和读取历史文件均不能降级', async () => {
  const current = await draft();
  await database.pool.query("UPDATE conversation SET max_data_level='confidential' WHERE id=$1", [
    current.conversationId,
  ]);
  const written = await writeDraftFile(database.pool, blobs.store, ra, current.id, {
    path: '草稿/分级.md',
    content: '分级测试合成内容',
    expectedSha256: null,
  });
  expect(written.file.dataLevel).toBe('confidential');
  expect(written.draft.dataLevel).toBe('confidential');
  expect((await getWorkspaceByProject(database.pool, ra, projectId)).dataLevel).toBe(
    'confidential',
  );
  const saved = await saveDraft(database.pool, blobs.store, ra, current.id, '保存分级测试');
  expect(saved.version.dataLevel).toBe('confidential');
  const restored = await restoreVersion(
    database.pool,
    blobs.store,
    ra,
    current.id,
    initialVersionId,
    '恢复内容但保持级别',
  );
  expect(restored.version.number).toBe(3);
  expect(restored.version.dataLevel).toBe('confidential');
  expect(
    (await readVersionFile(database.pool, blobs.store, ra, initialVersionId, 'AGENTS.md'))
      .dataLevel,
  ).toBe('confidential');
  for (const sql of [
    "UPDATE conversation SET max_data_level='internal' WHERE id=$1",
    "UPDATE workspace_draft SET data_level='internal' WHERE conversation_id=$1",
  ]) {
    await expect(database.pool.query(sql, [current.conversationId])).rejects.toMatchObject({
      code: '42501',
    });
  }
  await expect(
    database.pool.query("UPDATE workspace SET data_level='internal' WHERE id=$1", [workspaceId]),
  ).rejects.toMatchObject({ code: '42501' });
});

test('决定记录只追加，恢复旧版仍保留最新及未保存的决定历史', async () => {
  const current = await draft();
  let decision = await read(current.id, '决定记录.md');
  await expect(
    writeDraftFile(database.pool, blobs.store, ra, current.id, {
      path: decision.path,
      content: '覆盖原有记录',
      expectedSha256: decision.sha256,
    }),
  ).rejects.toMatchObject({ statusCode: 403, code: 'WORKSPACE_DECISIONS_APPEND_ONLY' });
  const firstHistory = initialDecisions + '\n第一条：待人工确认。\n';
  await writeDraftFile(database.pool, blobs.store, ra, current.id, {
    path: decision.path,
    content: firstHistory,
    expectedSha256: decision.sha256,
  });
  const report = await read(current.id, '草稿/检查记录.md');
  await writeDraftFile(database.pool, blobs.store, ra, current.id, {
    path: report.path,
    content: '新检查记录',
    expectedSha256: report.sha256,
  });
  const saved = await saveDraft(database.pool, blobs.store, ra, current.id, '新增记录及检查草稿');
  decision = await read(current.id, '决定记录.md');
  const fullHistory = firstHistory + '\n第二条：仍待人工确认。\n';
  await writeDraftFile(database.pool, blobs.store, ra, current.id, {
    path: decision.path,
    content: fullHistory,
    expectedSha256: decision.sha256,
  });
  const restored = await restoreVersion(
    database.pool,
    blobs.store,
    ra,
    current.id,
    initialVersionId,
    '恢复初稿，保留决定历史',
  );
  expect(restored.version.number).toBe(3);
  expect(restored.version.parentVersionId).toBe(saved.version.id);
  expect((await read(current.id, '草稿/检查记录.md')).text).toBe(initialReport);
  expect((await read(current.id, '决定记录.md')).text).toBe(fullHistory);
  expect(
    (await readVersionFile(database.pool, blobs.store, ra, initialVersionId, '决定记录.md')).text,
  ).toBe(initialDecisions);
  expect(
    (await readVersionFile(database.pool, blobs.store, ra, saved.version.id, '草稿/检查记录.md'))
      .text,
  ).toBe('新检查记录');
  expect(
    (
      await database.pool.query('SELECT id FROM workspace_draft_file WHERE draft_id=$1', [
        current.id,
      ])
    ).rowCount,
  ).toBe(0);
});

test('保存时二次检查决定记录，伪造删除overlay不能绕过追加约束', async () => {
  const current = await draft();
  await database.pool.query(
    "INSERT INTO workspace_draft_file(draft_id,path,sha256,byte_size,data_level,media_type,is_deleted) VALUES($1,'决定记录.md',NULL,NULL,'internal','text/markdown',true)",
    [current.id],
  );
  await expect(
    saveDraft(database.pool, blobs.store, ra, current.id, '尝试删除历史'),
  ).rejects.toMatchObject({ code: 'WORKSPACE_DECISIONS_APPEND_ONLY' });
  await expect(
    writeDraftFile(database.pool, blobs.store, ra, current.id, {
      path: '决定记录.md',
      content: '不能利用删除标记伪装成新文件',
      expectedSha256: null,
    }),
  ).rejects.toMatchObject({ code: 'WORKSPACE_DECISIONS_APPEND_ONLY' });
  expect((await getWorkspaceByProject(database.pool, ra, projectId)).currentVersionId).toBe(
    initialVersionId,
  );
});

test('已发布版本及文件不可改删或追加，current不能退回，跨工作区恢复拒绝', async () => {
  const current = await draft();
  const saved = await saveDraft(database.pool, blobs.store, ra, current.id, '建立第二版');
  await expect(
    database.pool.query("UPDATE workspace_version SET summary='篡改' WHERE id=$1", [
      initialVersionId,
    ]),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    database.pool.query('DELETE FROM workspace_file WHERE version_id=$1', [initialVersionId]),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(database.pool.query('TRUNCATE workspace_file')).rejects.toMatchObject({
    code: '42501',
  });
  const file = (await listVersionFiles(database.pool, ra, initialVersionId)).items[0]!;
  await expect(
    database.pool.query(
      "INSERT INTO workspace_file(version_id,path,sha256,byte_size,data_level,media_type) VALUES($1,'草稿/事后追加.md',$2,$3,'internal','text/plain')",
      [initialVersionId, file.sha256, file.byteSize],
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    database.pool.query('UPDATE workspace SET current_version_id=$1 WHERE id=$2', [
      initialVersionId,
      workspaceId,
    ]),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    database.pool.query('UPDATE workspace SET current_version_id=NULL WHERE id=$1', [workspaceId]),
  ).rejects.toMatchObject({ code: '42501' });
  const otherProject = await createProject(database.pool, ra, {
    name: '另一工作区的恢复边界',
    projectType: 'registration',
    market: 'US',
    pathway: '510(k)',
    reviewerUserId: rb.userId,
  });
  const client = await database.pool.connect();
  let otherVersionId: string;
  try {
    await client.query('BEGIN');
    const otherWorkspaceId = (
      await client.query<{ id: string }>(
        'INSERT INTO workspace(project_id) VALUES($1) RETURNING id',
        [otherProject.id],
      )
    ).rows[0]!.id;
    otherVersionId = (
      await client.query<{ id: string }>(
        "INSERT INTO workspace_version(workspace_id,project_id,number,author_type,summary,data_level) VALUES($1,$2,1,'system','他项目初始版本','internal') RETURNING id",
        [otherWorkspaceId, otherProject.id],
      )
    ).rows[0]!.id;
    await client.query('UPDATE workspace SET current_version_id=$1 WHERE id=$2', [
      otherVersionId,
      otherWorkspaceId,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await expect(
    restoreVersion(database.pool, blobs.store, ra, current.id, otherVersionId, '不能恢复外部版本'),
  ).rejects.toMatchObject({ statusCode: 404 });
  expect((await getWorkspaceByProject(database.pool, ra, projectId)).currentVersionId).toBe(
    saved.version.id,
  );
  const audit = await database.pool.query(
    "SELECT actor_kind,actor_user_id,after_hash FROM audit_log WHERE action='workspace.saved' AND target_id=$1",
    [saved.version.id],
  );
  expect(audit.rows[0]?.actor_kind).toBe('agent');
  expect(audit.rows[0]?.actor_user_id).toBe(ra.userId);
  expect(audit.rows[0]?.after_hash).toMatch(/^[a-f0-9]{64}$/);
});

test('NFC路径和有界Unicode文本读取保持一致，文件清单支持续读', async () => {
  const current = await draft();
  const content = '\ufeff甲😀𠀀' + '界'.repeat(12000);
  const written = await writeDraftFile(database.pool, blobs.store, ra, current.id, {
    path: '草稿/e\u0301.md',
    content,
    expectedSha256: null,
  });
  expect(written.file.path).toBe('草稿/é.md');
  await expect(
    writeDraftFile(database.pool, blobs.store, ra, current.id, {
      path: '草稿/é.md',
      content: '重复路径',
      expectedSha256: null,
    }),
  ).rejects.toMatchObject({ code: 'WORKSPACE_FILE_CONFLICT' });
  const first = await readDraftFile(database.pool, blobs.store, ra, current.id, '草稿/é.md', {
    limit: 12000,
  });
  const second = await readDraftFile(database.pool, blobs.store, ra, current.id, '草稿/é.md', {
    offset: first.nextOffset,
    limit: 12000,
  });
  expect(first.text + second.text === content).toBe(true);
  expect(first.text.length <= 12000).toBe(true);
  const list = await listDraftFiles(database.pool, ra, current.id, { limit: 2 });
  expect(list.hasMore).toBe(true);
  const next = await listDraftFiles(database.pool, ra, current.id, {
    cursor: list.nextCursor,
    limit: 2,
  });
  expect(next.hasMore).toBe(false);
  expect(next.items.some((file) => list.items.some((prior) => prior.path === file.path))).toBe(
    false,
  );
});
