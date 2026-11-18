import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  parseBackendConfig,
  workspaceRecordSchema,
  workspaceFileListSchema,
  workspaceReadFileSchema,
  workspaceDiffResponseSchema,
  type BrowserIdentity,
} from '@cert-board/shared';
import { createTestDatabase } from '../db/test-database.js';
import { migrateDatabase } from '../db/migrate.js';
import { seedDevelopmentAccounts } from '../db/seed.js';
import {
  seedDevelopmentProject,
  developmentProjectId,
  developmentGoalId,
} from '../projects/seed.js';
import { createTestBlobStore } from '../documents/test-blob-store.js';
import { seedDevelopmentWorkspace, developmentWorkspaceId } from './seed.js';
import { createDraft, writeDraftFile, saveDraft } from './service.js';
import { createApp } from '../app.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let storage: Awaited<ReturnType<typeof createTestBlobStore>>;
let app: ReturnType<typeof createApp>;
let headers: Record<string, string>;
let identity: BrowserIdentity;
const password = ['workspace', 'route', 'fixture', 'only'].join('-');
beforeAll(async () => {
  database = await createTestDatabase();
  storage = await createTestBlobStore();
  await migrateDatabase(database.pool);
  await seedDevelopmentAccounts(database.pool, {
    NODE_ENV: 'test',
    ...Object.fromEntries(
      ['ZHANGSAN', 'WANGMIN', 'ADMIN'].map((role) => [`DEV_${role}_PASSWORD`, password]),
    ),
  });
  await seedDevelopmentProject(database.pool, { NODE_ENV: 'test' });
  expect(
    (await seedDevelopmentWorkspace(database.pool, storage.store, { NODE_ENV: 'test' })).created,
  ).toBe(true);
  const config = parseBackendConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' });
  app = createApp(config, {
    database: database.pool,
    blobStore: storage.store,
    checkDatabase: async () => undefined,
    checkStorage: async () => undefined,
    close: async () => undefined,
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: config.WEB_ORIGIN, 'sec-fetch-site': 'same-origin' },
    payload: { username: 'zhangsan', password },
  });
  expect(login.statusCode).toBe(200);
  const user = login.json().user;
  headers = {
    cookie: String(login.headers['set-cookie']).split(';')[0] ?? '',
    'sec-fetch-site': 'same-origin',
  };
  identity = {
    kind: 'browser',
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    isDevelopment: true,
    sessionId: randomUUID(),
    isManagement: false,
  };
});
afterAll(async () => {
  if (app) await app.close();
  if (storage) await storage.dispose();
  if (database) await database.dispose();
});

test('开发工作区可读取五个初始化文件，文本路径与续读不越界', async () => {
  const result = await app.inject({
    url: `/api/projects/${developmentProjectId}/workspace`,
    headers,
  });
  expect(result.statusCode).toBe(200);
  const workspace = workspaceRecordSchema.parse(result.json());
  expect(workspace.id).toBe(developmentWorkspaceId);
  const files = await app.inject({ url: `/api/workspaces/${workspace.id}/files`, headers });
  expect(workspaceFileListSchema.parse(files.json()).items).toHaveLength(5);
  const content = await app.inject({
    url: `/api/workspaces/${workspace.id}/files/AGENTS.md?limit=100`,
    headers,
  });
  const read = workspaceReadFileSchema.parse(content.json());
  expect(read.text).toContain('L08 510(k)');
  expect(read.truncated).toBe(true);
  expect(read.nextOffset).toBe(100);
  const invalid = await app.inject({
    url: `/api/workspaces/${workspace.id}/files/%2e%2e%2fsecret`,
    headers,
  });
  expect(invalid.statusCode).toBe(400);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspace.id}/save`,
        headers,
        payload: {},
      })
    ).statusCode,
  ).toBe(404);
});

test('按版本只读对比新增交付文件，重复种子不覆盖人工后续版本', async () => {
  const before = (
    await database.pool.query<{ current_version_id: string }>(
      'SELECT current_version_id FROM workspace WHERE id=$1',
      [developmentWorkspaceId],
    )
  ).rows[0]!.current_version_id;
  const conversation = await database.pool.query<{ id: string }>(
    "INSERT INTO conversation(project_id,user_id,goal_id,title,permission_mode) VALUES ($1,$2,$3,'工作区接口验收','ask') RETURNING id",
    [developmentProjectId, identity.userId, developmentGoalId],
  );
  const draft = await createDraft(database.pool, identity, conversation.rows[0]!.id);
  await writeDraftFile(database.pool, storage.store, identity, draft.id, {
    path: '交付/检查记录.md',
    content: '# 检查记录\n\n第一条待确认。\n',
    expectedSha256: null,
  });
  const saved = await saveDraft(
    database.pool,
    storage.store,
    identity,
    draft.id,
    '保存示例检查记录',
  );
  const changes = await app.inject({
    url: `/api/workspaces/${developmentWorkspaceId}/diff?from=${before}&to=${saved.version.id}`,
    headers,
  });
  const diff = workspaceDiffResponseSchema.parse(changes.json());
  expect(diff.kind).toBe('files');
  if (diff.kind === 'files')
    expect(diff.changes.map((item) => [item.path, item.change])).toEqual([
      ['交付/检查记录.md', 'added'],
    ]);
  const lines = await app.inject({
    url: `/api/workspaces/${developmentWorkspaceId}/diff?from=${before}&to=${saved.version.id}&path=${encodeURIComponent('交付/检查记录.md')}`,
    headers,
  });
  const detail = workspaceDiffResponseSchema.parse(lines.json());
  expect(detail.kind).toBe('text');
  if (detail.kind === 'text') {
    expect(detail.diff.available).toBe(true);
    expect(
      detail.diff.lines.some((line) => line.text === '第一条待确认。' && line.kind === 'added'),
    ).toBe(true);
  }
  expect(
    (await seedDevelopmentWorkspace(database.pool, storage.store, { NODE_ENV: 'test' })).created,
  ).toBe(false);
  const current = await database.pool.query(
    'SELECT current_version_id FROM workspace WHERE id=$1',
    [developmentWorkspaceId],
  );
  expect(current.rows[0]?.current_version_id).toBe(saved.version.id);
});

test('工作区种子在生产环境拒绝，未登录读取拒绝', async () => {
  await expect(
    seedDevelopmentWorkspace(database.pool, storage.store, { NODE_ENV: 'production' }),
  ).rejects.toThrow('只允许');
  expect(
    (
      await app.inject({
        url: `/api/projects/${developmentProjectId}/workspace`,
        headers: { 'sec-fetch-site': 'same-origin' },
      })
    ).statusCode,
  ).toBe(401);
});
