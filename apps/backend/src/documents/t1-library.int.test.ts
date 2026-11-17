import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  parseBackendConfig,
  documentListSchema,
  documentPageReadSchema,
  documentSearchResultSchema,
} from '@cert-board/shared';
import { createTestDatabase } from '../db/test-database.js';
import { migrateDatabase } from '../db/migrate.js';
import { seedDevelopmentAccounts } from '../db/seed.js';
import { seedDevelopmentProject, developmentProjectId } from '../projects/seed.js';
import { createTestBlobStore } from './test-blob-store.js';
import { seedT1Documents } from './t1-seed.js';
import { createApp } from '../app.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let storage: Awaited<ReturnType<typeof createTestBlobStore>>;
let app: ReturnType<typeof createApp>;
let headers: Record<string, string>;
let doc35: string;
let placeholder: string;
const password = ['t1', 'library', 'fixture', 'only'].join('-');
beforeAll(async () => {
  database = await createTestDatabase();
  storage = await createTestBlobStore();
  await migrateDatabase(database.pool);
  await seedDevelopmentAccounts(database.pool, {
    NODE_ENV: 'test',
    ...Object.fromEntries(
      ['RA', 'RB', 'GM', 'SALES', 'TECH'].map((role) => [`DEV_${role}_PASSWORD`, password]),
    ),
  });
  await seedDevelopmentProject(database.pool, { NODE_ENV: 'test' });
  const result = await seedT1Documents(database.pool, storage.store, { NODE_ENV: 'test' });
  expect(result.documentCount).toBe(59);
  expect(result.pageCount).toBe(664);
  const config = parseBackendConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' });
  app = createApp(config, {
    database: database.pool,
    checkDatabase: async () => undefined,
    checkStorage: async () => undefined,
    close: async () => undefined,
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: config.WEB_ORIGIN, 'sec-fetch-site': 'same-origin' },
    payload: { username: 'ra', password },
  });
  expect(login.statusCode).toBe(200);
  headers = {
    cookie: String(login.headers['set-cookie']).split(';')[0] ?? '',
    'sec-fetch-site': 'same-origin',
  };
  const rows = await database.pool.query<{ id: string; source_key: string }>(
    'SELECT id,source_key FROM document',
  );
  doc35 = rows.rows.find((d) => d.source_key === 'D035')!.id;
  placeholder = rows.rows.find((d) => d.source_key === 'D014')!.id;
}, 30000);
afterAll(async () => {
  if (app) await app.close();
  if (storage) await storage.dispose();
  if (database) await database.dispose();
});

test('实际T1种子重复运行不增加版本或页，59个来源身份保持', async () => {
  await seedT1Documents(database.pool, storage.store, { NODE_ENV: 'test' });
  const rows = await database.pool.query(
    'SELECT (SELECT count(*)::int FROM document) AS documents,(SELECT count(*)::int FROM document_version) AS versions,(SELECT count(*)::int FROM document_page) AS pages',
  );
  expect(rows.rows).toEqual([{ documents: 59, versions: 59, pages: 664 }]);
});

test('资料读取分页与检索返回确实存在的两个K号，不声称原始PDF已导入', async () => {
  const first = await app.inject({
    url: `/api/projects/${developmentProjectId}/documents?limit=50`,
    headers,
  });
  const list = documentListSchema.parse(first.json());
  expect(list.items).toHaveLength(50);
  expect(list.hasMore).toBe(true);
  const second = await app.inject({
    url: `/api/projects/${developmentProjectId}/documents?cursor=${list.nextCursor}`,
    headers,
  });
  expect(documentListSchema.parse(second.json()).items).toHaveLength(9);
  for (const [page, quote] of [
    [1, '510(k) Number: K170825'],
    [5, '510(K) number K170285'],
  ] as const) {
    const response = await app.inject({
      url: `/api/documents/${doc35}/versions/1/pages/${page}`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const data = documentPageReadSchema.parse(response.json());
    expect(data.text.includes(quote)).toBe(true);
    expect(data.sourceKey).toBe('D035');
    expect(data.warning).toContain('原始文件尚未导入');
  }
  const found = await app.inject({
    url: `/api/projects/${developmentProjectId}/documents/search?query=K170285`,
    headers,
  });
  const results = documentSearchResultSchema.parse(found.json());
  expect(results.items.some((item) => item.sourceKey === 'D035' && item.page === 5)).toBe(true);
  expect(results.items.every((item) => item.snippet.length <= 300)).toBe(true);
});

test('eSTAR占位页拒绝作为正文，OCR与Word定位提示保留，浏览器上传入口尚未开放', async () => {
  expect(
    (await app.inject({ url: `/api/documents/${placeholder}/versions/1/pages/1`, headers }))
      .statusCode,
  ).toBe(422);
  const docs = await database.pool.query<{ id: string; source_key: string }>(
    "SELECT id,source_key FROM document WHERE source_key IN ('D005','D001')",
  );
  for (const doc of docs.rows) {
    const result = await app.inject({
      url: `/api/documents/${doc.id}/versions/1/pages/${doc.source_key === 'D005' ? 2 : 1}`,
      headers,
    });
    const data = documentPageReadSchema.parse(result.json());
    if (doc.source_key === 'D005') {
      expect(data.ocrScore).toBe(0.812);
      expect(data.warning).toContain('置信度较低');
    } else {
      expect(data.locatorKind).toBe('extraction_unit');
      expect(data.warning).toContain('不代表Word物理页码');
    }
  }
  expect(
    (await app.inject({ method: 'POST', url: '/api/documents', headers, payload: {} })).statusCode,
  ).toBe(404);
});
