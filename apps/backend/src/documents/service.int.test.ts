import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  browserIdentitySchema,
  type BrowserIdentity,
  type DocumentImport,
} from '@cert-board/shared';
import { createTestDatabase } from '../db/test-database.js';
import { migrateDatabase } from '../db/migrate.js';
import { seedDevelopmentAccounts } from '../db/seed.js';
import { createProject } from '../projects/service.js';
import { createTestBlobStore } from './test-blob-store.js';
import {
  getDocument,
  ingestParsedDocument,
  listDocuments,
  listDocumentVersions,
  readDocumentPage,
  searchDocuments,
} from './service.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let blobs: Awaited<ReturnType<typeof createTestBlobStore>>;
let ra: BrowserIdentity;
let projectId: string;
let otherProjectId: string;
function source(sourceKey: string, text: string): DocumentImport {
  return {
    projectId,
    sourceKey,
    name: `${sourceKey}.pdf`,
    sourcePath: `samples/${sourceKey}.pdf`,
    sourceSnapshot: digest(`${sourceKey}:snapshot-1`),
    originalSha256: digest(`${sourceKey}:original-bytes-not-imported`),
    dataLevel: 'internal',
    authorType: 'external',
    sourceMetadata: { origin: '独立集成测试' },
    pages: [
      {
        pageNumber: 1,
        text,
        method: 'text',
        locatorKind: 'physical_page',
        ocrScore: null,
        isPlaceholder: false,
      },
    ],
  };
}
async function objectCount() {
  let count = 0;
  for await (const _item of blobs.client.listObjectsV2(blobs.bucket, 'sha256/', true)) count++;
  return count;
}

beforeAll(async () => {
  database = await createTestDatabase();
  await migrateDatabase(database.pool);
  const password = (role: string) => ['document', 'integration', role, 'example'].join('-');
  await seedDevelopmentAccounts(database.pool, {
    NODE_ENV: 'test',
    DEV_RA_PASSWORD: password('ra'),
    DEV_RB_PASSWORD: password('rb'),
    DEV_GM_PASSWORD: password('gm'),
    DEV_SALES_PASSWORD: password('sales'),
    DEV_TECH_PASSWORD: password('tech'),
  });
  const users = await database.pool.query(
    "SELECT id,username,display_name FROM app_user WHERE username IN ('ra','rb') ORDER BY username",
  );
  const user = users.rows.find((row) => row.username === 'ra');
  const reviewer = users.rows.find((row) => row.username === 'rb');
  ra = browserIdentitySchema.parse({
    kind: 'browser',
    userId: user.id,
    username: 'ra',
    displayName: user.display_name,
    isDevelopment: true,
    sessionId: randomUUID(),
    roles: [{ role: 'RA', scopeType: 'global', scopeId: null }],
  });
  const input = {
    projectType: 'registration',
    market: 'US',
    pathway: '510(k)',
    reviewerUserId: reviewer.id,
  };
  projectId = (await createProject(database.pool, ra, { ...input, name: '资料服务独立测试' })).id;
  otherProjectId = (await createProject(database.pool, ra, { ...input, name: '其他项目独立测试' }))
    .id;
  blobs = await createTestBlobStore();
});
afterAll(async () => {
  const results = await Promise.allSettled([blobs?.dispose(), database?.dispose()]);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
});

test('真实MinIO按内容去重，来源身份保留，原始文件hash与解析内容hash分开', async () => {
  const before = await objectCount();
  const firstInput = source('DEDUP-01', '去重测试专用内容\n510(k) Number: K170825');
  const secondInput = {
    ...firstInput,
    sourceKey: 'DEDUP-02',
    name: '另一来源.pdf',
    sourcePath: 'other/另一来源.pdf',
  };
  const first = await ingestParsedDocument(database.pool, blobs.store, firstInput);
  const second = await ingestParsedDocument(database.pool, blobs.store, secondInput);
  expect(first.documentId === second.documentId).toBe(false);
  expect(first.contentSha256).toBe(second.contentSha256);
  expect(await objectCount()).toBe(before + 1);
  const content = await blobs.store.get(first.contentSha256);
  expect(digest(content.toString('utf8'))).toBe(first.contentSha256);
  const versions = await listDocumentVersions(database.pool, ra, first.documentId);
  expect(versions.items[0]?.originalSha256).toBe(firstInput.originalSha256);
  expect(versions.items[0]?.contentSha256 === firstInput.originalSha256).toBe(false);
  expect(versions.items[0]?.contentKind).toBe('parsed_text');
  expect(versions.items[0]?.byteSize).toBe(content.byteLength);
  expect(versions.items[0]?.importedBy).toBeNull();
  const policy = await blobs.client.getBucketPolicy(blobs.bucket).catch((error: unknown) => {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'NoSuchBucketPolicy'
    )
      return '';
    throw error;
  });
  expect(policy).toBe('');
});

test('同快照导入幂等、变化快照追加版本，重放旧快照不切换当前版', async () => {
  const input = source('VERSION-01', '初版原文');
  const [first, parallel] = await Promise.all([
    ingestParsedDocument(database.pool, blobs.store, input),
    ingestParsedDocument(database.pool, blobs.store, input),
  ]);
  expect(first.versionId).toBe(parallel.versionId);
  expect([first.created, parallel.created].filter(Boolean)).toHaveLength(1);
  const next = await ingestParsedDocument(database.pool, blobs.store, {
    ...input,
    sourceSnapshot: digest('snapshot-2'),
    name: '新版名称.pdf',
    pages: [{ ...input.pages[0]!, text: '第二版原文' }],
  });
  expect(next.version).toBe(2);
  const replay = await ingestParsedDocument(database.pool, blobs.store, input);
  expect(replay.created).toBe(false);
  expect(replay.version).toBe(1);
  expect((await getDocument(database.pool, ra, first.documentId)).currentVersion).toBe(2);
  const old = await readDocumentPage(database.pool, ra, first.documentId, 1, 1);
  expect(old.text).toBe('初版原文');
  expect(old.name).toBe(input.name);
  const page = await listDocumentVersions(database.pool, ra, first.documentId, { limit: 1 });
  expect(page.hasMore).toBe(true);
  expect(page.nextAfterVersion).toBe(1);
  const tail = await listDocumentVersions(database.pool, ra, first.documentId, {
    afterVersion: page.nextAfterVersion,
    limit: 1,
  });
  expect(tail.items[0]?.version).toBe(2);
  expect(tail.hasMore).toBe(false);
  const audit = await database.pool.query(
    "SELECT before_hash,after_hash FROM audit_log WHERE action='document.imported' AND target_id IN ($1,$2)",
    [first.versionId, next.versionId],
  );
  expect(audit.rowCount).toBe(2);
  expect(JSON.stringify(audit.rows).includes('原文')).toBe(false);
});

test('相同快照内容或元数据变化拒绝覆盖，缺级别及伪造内容哈希拒绝', async () => {
  const input = source('VALIDATE-01', '固定版本原文');
  const first = await ingestParsedDocument(database.pool, blobs.store, input);
  await expect(
    ingestParsedDocument(database.pool, blobs.store, {
      ...input,
      pages: [{ ...input.pages[0]!, text: '被改写的原文' }],
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  await expect(
    ingestParsedDocument(database.pool, blobs.store, { ...input, dataLevel: 'confidential' }),
  ).rejects.toMatchObject({ statusCode: 409 });
  await expect(
    ingestParsedDocument(database.pool, blobs.store, { ...input, dataLevel: undefined }),
  ).rejects.toMatchObject({ statusCode: 400 });
  await expect(
    ingestParsedDocument(database.pool, blobs.store, { ...input, contentSha256: 'a'.repeat(64) }),
  ).rejects.toMatchObject({ statusCode: 400 });
  expect((await listDocumentVersions(database.pool, ra, first.documentId)).items).toHaveLength(1);
});

test('长页分段读取可还原原文，空白和Unicode组合字符保持不变', async () => {
  const text = '  原始前导空白\r\nA\u0301\t' + '甲'.repeat(16218) + '\n尾部  ';
  const input = source('LONG-01', text);
  input.pages[0]!.method = 'docx';
  input.pages[0]!.locatorKind = 'extraction_unit';
  const document = await ingestParsedDocument(database.pool, blobs.store, input);
  const first = await readDocumentPage(database.pool, ra, document.documentId, 1, 1, {
    limit: 12000,
  });
  expect(first.text.length).toBe(12000);
  expect(first.truncated).toBe(true);
  expect(first.nextOffset).toBe(12000);
  const next = await readDocumentPage(database.pool, ra, document.documentId, 1, 1, {
    offset: first.nextOffset,
    limit: 12000,
  });
  expect(first.text + next.text === text).toBe(true);
  expect(next.truncated).toBe(false);
  expect(next.nextOffset).toBeNull();
  expect(first.locatorKind).toBe('extraction_unit');
  expect(first.warning?.includes('不代表Word物理页码')).toBe(true);
  await expect(
    readDocumentPage(database.pool, ra, document.documentId, 1, 1, { limit: 12001 }),
  ).rejects.toMatchObject({ statusCode: 400 });
  await expect(
    readDocumentPage(database.pool, ra, document.documentId, 1, 1, { offset: text.length + 1 }),
  ).rejects.toMatchObject({ statusCode: 400 });
});

test('Unicode代理对分页不拆开emoji或扩展汉字，续读可逐字还原', async () => {
  const text = '甲😀𠀀乙';
  const saved = await ingestParsedDocument(database.pool, blobs.store, source('UNICODE-01', text));
  const loneSurrogate = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
  const pieces: string[] = [];
  let offset = 0;
  for (let step = 0; step < 10; step++) {
    const page = await readDocumentPage(database.pool, ra, saved.documentId, 1, 1, {
      offset,
      limit: 2,
    });
    expect(loneSurrogate.test(page.text)).toBe(false);
    expect(page.text.length <= 2).toBe(true);
    pieces.push(page.text);
    if (!page.truncated) break;
    expect(page.nextOffset !== null && page.nextOffset > offset).toBe(true);
    offset = page.nextOffset ?? text.length;
  }
  expect(pieces.join('') === text).toBe(true);
  await expect(
    readDocumentPage(database.pool, ra, saved.documentId, 1, 1, { offset: 2, limit: 2 }),
  ).rejects.toMatchObject({ statusCode: 400, code: 'DOCUMENT_OFFSET_INVALID' });
  await expect(
    readDocumentPage(database.pool, ra, saved.documentId, 1, 1, { offset: 1, limit: 1 }),
  ).rejects.toMatchObject({ statusCode: 400, code: 'DOCUMENT_READ_LIMIT_TOO_SMALL' });
});

test('OCR置信度保留，阅读器占位页可查metadata但不返回正文或检索命中', async () => {
  const input = source('OCR-01', 'OCR示例原文');
  input.pages[0]!.method = 'ocr';
  input.pages[0]!.ocrScore = 0.812;
  const ocr = await ingestParsedDocument(database.pool, blobs.store, input);
  const page = await readDocumentPage(database.pool, ra, ocr.documentId, 1, 1);
  expect(page.ocrScore).toBe(0.812);
  expect(page.warning?.includes('置信度较低')).toBe(true);
  const placeholderInput = source(
    'PLACEHOLDER-01',
    'Please wait... PLACEHOLDER_UNIQUE Adobe reader',
  );
  placeholderInput.pages[0]!.isPlaceholder = true;
  const placeholder = await ingestParsedDocument(database.pool, blobs.store, placeholderInput);
  expect((await getDocument(database.pool, ra, placeholder.documentId)).id).toBe(
    placeholder.documentId,
  );
  await expect(
    readDocumentPage(database.pool, ra, placeholder.documentId, 1, 1),
  ).rejects.toMatchObject({ statusCode: 422, code: 'DOCUMENT_PLACEHOLDER' });
  expect(
    (await searchDocuments(database.pool, ra, projectId, { query: 'PLACEHOLDER_UNIQUE' })).items,
  ).toHaveLength(0);
});

test('升级为保密后所有历史版本与当前版返回最高数据级别', async () => {
  const input = source('LEVEL-01', '级别检查原文');
  const first = await ingestParsedDocument(database.pool, blobs.store, input);
  await ingestParsedDocument(database.pool, blobs.store, {
    ...input,
    sourceSnapshot: digest('confidential-snapshot'),
    dataLevel: 'confidential',
  });
  await ingestParsedDocument(database.pool, blobs.store, {
    ...input,
    sourceSnapshot: digest('later-public-snapshot'),
    dataLevel: 'public',
  });
  expect((await getDocument(database.pool, ra, first.documentId)).dataLevel).toBe('confidential');
  expect((await readDocumentPage(database.pool, ra, first.documentId, 1, 1)).dataLevel).toBe(
    'confidential',
  );
  expect(
    (await listDocumentVersions(database.pool, ra, first.documentId)).items.every(
      (version) => version.dataLevel === 'confidential',
    ),
  ).toBe(true);
  expect(
    (await searchDocuments(database.pool, ra, projectId, { query: '级别检查原文' })).items[0]
      ?.dataLevel,
  ).toBe('confidential');
});

test('资料列表与检索有续读，结果只给有界摘要和定位，不返回全文', async () => {
  for (let index = 1; index <= 3; index++)
    await ingestParsedDocument(
      database.pool,
      blobs.store,
      source(`SEARCH-${index}`, `SEARCH_UNIQUE ${'原文'.repeat(400)}`),
    );
  const first = await searchDocuments(database.pool, ra, projectId, {
    query: 'SEARCH_UNIQUE',
    limit: 2,
  });
  expect(first.items).toHaveLength(2);
  expect(first.hasMore).toBe(true);
  expect(first.nextOffset).toBe(2);
  expect(
    first.items.every(
      (item) =>
        item.snippet.length <= 300 && !('text' in item) && item.version === 1 && item.page === 1,
    ),
  ).toBe(true);
  const next = await searchDocuments(database.pool, ra, projectId, {
    query: 'SEARCH_UNIQUE',
    limit: 2,
    offset: first.nextOffset,
  });
  expect(next.items).toHaveLength(1);
  expect(next.hasMore).toBe(false);
  expect(first.items.some((item) => item.documentId === next.items[0]?.documentId)).toBe(false);
  const list = await listDocuments(database.pool, ra, projectId, { limit: 2 });
  expect(list.items).toHaveLength(2);
  expect(list.hasMore).toBe(true);
  const more = await listDocuments(database.pool, ra, projectId, {
    limit: 2,
    cursor: list.nextCursor,
  });
  expect(more.items.some((item) => list.items.some((prior) => prior.id === item.id))).toBe(false);
});

test('跨项目资料不可见，作废后不能读取、检索或重复导入恢复', async () => {
  const input = source('VOID-01', 'VOID_UNIQUE 原文');
  const document = await ingestParsedDocument(database.pool, blobs.store, input);
  const scoped: BrowserIdentity = {
    ...ra,
    roles: [{ role: 'RA', scopeType: 'project', scopeId: otherProjectId }],
  };
  await expect(getDocument(database.pool, scoped, document.documentId)).rejects.toMatchObject({
    statusCode: 404,
    code: 'DOCUMENT_NOT_FOUND',
  });
  await expect(
    readDocumentPage(database.pool, scoped, document.documentId, 1, 1),
  ).rejects.toMatchObject({ statusCode: 404 });
  await expect(
    searchDocuments(database.pool, scoped, projectId, { query: 'VOID_UNIQUE' }),
  ).rejects.toMatchObject({ statusCode: 404 });
  await database.pool.query(
    "UPDATE document SET voided=true,void_reason='测试作废',version=version+1 WHERE id=$1",
    [document.documentId],
  );
  await expect(getDocument(database.pool, ra, document.documentId)).rejects.toMatchObject({
    statusCode: 404,
  });
  await expect(listDocumentVersions(database.pool, ra, document.documentId)).rejects.toMatchObject({
    statusCode: 404,
  });
  await expect(
    readDocumentPage(database.pool, ra, document.documentId, 1, 1),
  ).rejects.toMatchObject({ statusCode: 404 });
  expect(
    (await searchDocuments(database.pool, ra, projectId, { query: 'VOID_UNIQUE' })).items,
  ).toHaveLength(0);
  await expect(ingestParsedDocument(database.pool, blobs.store, input)).rejects.toMatchObject({
    statusCode: 409,
    code: 'DOCUMENT_VOIDED',
  });
});

test('已登记资料版本与逐页原文由数据库拒绝修改和删除', async () => {
  const saved = await ingestParsedDocument(
    database.pool,
    blobs.store,
    source('IMMUTABLE-01', '不能覆盖的证据'),
  );
  for (const sql of [
    "UPDATE document_page SET text='被覆盖' WHERE version_id=$1",
    'DELETE FROM document_page WHERE version_id=$1',
    "UPDATE document_version SET data_level='public' WHERE id=$1",
    'DELETE FROM document_version WHERE id=$1',
  ]) {
    await expect(database.pool.query(sql, [saved.versionId])).rejects.toMatchObject({
      code: '42501',
    });
  }
  await expect(
    database.pool.query('DELETE FROM document WHERE id=$1', [saved.documentId]),
  ).rejects.toMatchObject({ code: '42501' });
  expect((await readDocumentPage(database.pool, ra, saved.documentId, 1, 1)).text).toBe(
    '不能覆盖的证据',
  );
});
