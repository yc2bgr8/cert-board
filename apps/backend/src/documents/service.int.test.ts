import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import {
  browserIdentitySchema,
  parseBackendConfig,
  type BrowserIdentity,
  type DocumentImport,
} from '@cert-board/shared';
import { createTestDatabase } from '../db/test-database.js';
import { migrateDatabase } from '../db/migrate.js';
import { seedDevelopmentAccounts } from '../db/seed.js';
import { createProject } from '../projects/service.js';
import { createTestBlobStore } from './test-blob-store.js';
import { AppError } from '../api/errors.js';
import { createApp } from '../app.js';
import { processDocumentParseTask, queueOriginalDocument } from './parse-tasks.js';
import {
  getDocument,
  ingestParsedDocument,
  listDocuments,
  listDocumentVersions,
  readDocumentPage,
  searchDocuments,
} from './service.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const password = (role: string) => ['document', 'integration', role, 'example'].join('-');
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let blobs: Awaited<ReturnType<typeof createTestBlobStore>>;
let ra: BrowserIdentity;
let memberB: BrowserIdentity;
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
  await seedDevelopmentAccounts(database.pool, {
    NODE_ENV: 'test',
    DEV_ZHANGSAN_PASSWORD: password('zhangsan'),
    DEV_WANGMIN_PASSWORD: password('wangmin'),
    DEV_ADMIN_PASSWORD: password('admin'),
  });
  const users = await database.pool.query(
    "SELECT id,username,display_name FROM app_user WHERE username IN ('zhangsan','wangmin') ORDER BY username",
  );
  const user = users.rows.find((row) => row.username === 'zhangsan');
  const reviewer = users.rows.find((row) => row.username === 'wangmin');
  ra = browserIdentitySchema.parse({
    kind: 'browser',
    userId: user.id,
    username: 'zhangsan',
    displayName: user.display_name,
    isDevelopment: true,
    sessionId: randomUUID(),
    isManagement: false,
  });
  memberB = { ...ra, userId: reviewer.id, username: 'wangmin', sessionId: randomUUID() };
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

test('原件版本幂等入队，解析时保留旧检索，完成后暴露中英文与低置信页', async () => {
  const previous = await ingestParsedDocument(
    database.pool,
    blobs.store,
    source('RAW-01', '旧版本内容'),
  );
  const raw = Buffer.from('%PDF-1.4 fictional new source');
  const input = {
    projectId,
    sourceKey: 'RAW-01',
    name: '新版合成资料.pdf',
    sourcePath: 'samples/new.pdf',
    sourceSnapshot: digest('raw-01:version-2'),
    format: 'pdf',
    authorType: 'human',
    dataLevel: 'internal',
  };
  const first = await queueOriginalDocument(database.pool, blobs.store, ra, input, raw);
  expect(first).toMatchObject({ created: true, documentId: previous.documentId, version: 2 });
  await expect(
    queueOriginalDocument(database.pool, blobs.store, ra, input, raw),
  ).resolves.toMatchObject({
    created: false,
    versionId: first.versionId,
  });
  await expect(
    queueOriginalDocument(database.pool, blobs.store, ra, input, Buffer.from('different fixture')),
  ).rejects.toMatchObject({ code: 'DOCUMENT_SNAPSHOT_CONFLICT' });
  expect(await getDocument(database.pool, ra, first.documentId)).toMatchObject({
    parseState: 'queued',
    readablePage: { version: 1, page: 1 },
  });
  expect(
    (await searchDocuments(database.pool, ra, projectId, { query: '旧版本内容' })).items[0]
      ?.version,
  ).toBe(1);
  let notifyClaim!: () => void;
  let allowCompletion!: () => void;
  const called = new Promise<void>((resolve) => {
    notifyClaim = resolve;
  });
  const proceed = new Promise<void>((resolve) => {
    allowCompletion = resolve;
  });
  const parse = vi.fn(async () => {
    notifyClaim();
    await proceed;
    return [
      {
        pageNumber: 1,
        method: 'ocr' as const,
        locatorKind: 'physical_page' as const,
        text: '对比器械 fixture predicate',
        ocrScore: 0.85,
        isPlaceholder: false,
      },
    ];
  });
  const running = processDocumentParseTask(database.pool, blobs.store, { parse });
  await called;
  try {
    expect((await getDocument(database.pool, ra, first.documentId)).parseState).toBe('running');
    await expect(processDocumentParseTask(database.pool, blobs.store, { parse })).resolves.toBe(
      false,
    );
  } finally {
    allowCompletion();
    await running;
  }
  expect(parse).toHaveBeenCalledExactlyOnceWith(raw, digest(raw.toString()), 'pdf', undefined);
  for (const word of ['对比器械', 'PREDICATE']) {
    expect((await searchDocuments(database.pool, ra, projectId, { query: word })).items).toEqual([
      expect.objectContaining({
        documentId: first.documentId,
        version: 2,
        page: 1,
        dataLevel: 'internal',
      }),
    ]);
  }
  const page = await readDocumentPage(database.pool, ra, first.documentId, 2, 1);
  expect(page.ocrScore).toBe(0.85);
  expect(page.warning).toContain('置信度');
  expect(
    (await listDocumentVersions(database.pool, ra, first.documentId)).items[1]?.parseStatus,
  ).toEqual({ state: 'ready', attempts: 1, lowConfidencePages: 1, errorCode: null });
});

test('暂时繁忙会重试，确定失败只记录安全错误码且不发布空资料页', async () => {
  const original = await queueOriginalDocument(
    database.pool,
    blobs.store,
    ra,
    {
      projectId,
      sourceKey: 'RAW-02',
      name: '合成格式错误.pdf',
      sourcePath: 'samples/failure.pdf',
      sourceSnapshot: digest('raw-02'),
      format: 'pdf',
      authorType: 'human',
      dataLevel: 'internal',
    },
    Buffer.from('fictional input'),
  );
  const parse = vi
    .fn()
    .mockRejectedValueOnce(new AppError(429, 'DOC_BUSY', 'private fixture trace'))
    .mockRejectedValueOnce(new AppError(422, 'DOC_FORMAT_MISMATCH', 'private fixture trace'));
  await processDocumentParseTask(database.pool, blobs.store, { parse });
  const queued = (await listDocumentVersions(database.pool, ra, original.documentId)).items[0]
    ?.parseStatus;
  expect(queued).toMatchObject({ state: 'queued', attempts: 1, errorCode: 'DOC_BUSY' });
  await database.pool.query(
    'UPDATE document_parse_task SET available_at=clock_timestamp() WHERE version_id=$1',
    [original.versionId],
  );
  await processDocumentParseTask(database.pool, blobs.store, { parse });
  expect(
    (await listDocumentVersions(database.pool, ra, original.documentId)).items[0],
  ).toMatchObject({
    pageCount: 0,
    parseStatus: { state: 'failed', attempts: 2, errorCode: 'DOC_FORMAT_MISMATCH' },
  });
  await expect(
    readDocumentPage(database.pool, ra, original.documentId, 1, 1),
  ).rejects.toMatchObject({ statusCode: 404 });
});

test('第三次领取时正常停机释放租约，后续可以继续解析', async () => {
  const item = await queueOriginalDocument(
    database.pool,
    blobs.store,
    ra,
    {
      projectId,
      sourceKey: 'RAW-STOP',
      name: '停机续跑样例.pdf',
      sourcePath: 'stop.pdf',
      sourceSnapshot: digest('raw-stop'),
      format: 'pdf',
      authorType: 'human',
      dataLevel: 'internal',
    },
    Buffer.from('fictional stopped input'),
  );
  await database.pool.query('UPDATE document_parse_task SET attempts=2 WHERE version_id=$1', [
    item.versionId,
  ]);
  const stopping = new AbortController();
  await processDocumentParseTask(
    database.pool,
    blobs.store,
    {
      async parse() {
        stopping.abort();
        throw new AppError(503, 'DOCSVC_UNAVAILABLE', 'fictional stopped worker');
      },
    },
    stopping.signal,
  );
  const status = async () =>
    (await listDocumentVersions(database.pool, ra, item.documentId)).items[0]?.parseStatus;
  expect(await status()).toMatchObject({ state: 'queued', attempts: 2, errorCode: null });
  await processDocumentParseTask(database.pool, blobs.store, {
    async parse() {
      return [
        {
          pageNumber: 1,
          method: 'text',
          locatorKind: 'physical_page',
          ocrScore: null,
          text: '恢复后解析完成。',
          isPlaceholder: false,
        },
      ];
    },
  });
  expect(await status()).toMatchObject({ state: 'ready', attempts: 3, errorCode: null });
});

test('浏览器单原件入口需要会话和 CSRF，同一原件重传只领取一个版本', async () => {
  const config = parseBackendConfig({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    CERT_DOCSVC_URL: 'http://127.0.0.1:28082',
  });
  let holdUploads = false;
  let activeStores = 0;
  let notifyBoth!: () => void;
  let releaseUploads!: () => void;
  const bothStoring = new Promise<void>((resolve) => {
    notifyBoth = resolve;
  });
  const canStore = new Promise<void>((resolve) => {
    releaseUploads = resolve;
  });
  const app = createApp(config, {
    database: database.pool,
    blobStore: {
      get: (sha256) => blobs.store.get(sha256),
      async put(content) {
        if (holdUploads) {
          if (++activeStores === 2) notifyBoth();
          await canStore;
        }
        return blobs.store.put(content);
      },
    },
    checkDatabase: async () => undefined,
    checkStorage: async () => undefined,
    close: async () => undefined,
  });
  const disabled = createApp(
    { ...config, CERT_DOCSVC_URL: undefined },
    {
      database: database.pool,
      blobStore: blobs.store,
      checkDatabase: async () => undefined,
      checkStorage: async () => undefined,
      close: async () => undefined,
    },
  );
  try {
    const sameOrigin = { origin: config.WEB_ORIGIN, 'sec-fetch-site': 'same-origin' };
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: sameOrigin,
      payload: { username: 'zhangsan', password: password('zhangsan') },
    });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const payload = Buffer.from('%PDF-1.4 fictional upload');
    const submit = (
      authenticated: boolean,
      csrf: boolean,
      name = 'fixture-upload.pdf',
      query = '',
      target = app,
    ) =>
      target.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/documents/original?name=${name}&format=pdf${query}`,
        headers: {
          ...sameOrigin,
          'content-type': 'application/octet-stream',
          ...(authenticated ? { cookie } : {}),
          ...(csrf ? { 'x-csrf-token': login.json().csrfToken } : {}),
        },
        payload,
      });
    expect((await submit(false, false)).statusCode).toBe(401);
    expect((await submit(true, false)).statusCode).toBe(403);
    const blocked = await submit(true, true, undefined, '', disabled);
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json()).toMatchObject({ error: { code: 'DOCUMENT_PARSER_DISABLED' } });
    const saved = await submit(true, true);
    expect(saved.statusCode).toBe(202);
    const replay = await submit(true, true);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ ...saved.json(), created: false });
    const explicitKey = `&sourceKey=file-${digest('fixture-upload.pdf')}&dataLevel=internal`;
    const explicit = await submit(true, true, undefined, explicitKey);
    expect(explicit.statusCode).toBe(200);
    expect(explicit.json()).toEqual(replay.json());
    const versions = await listDocumentVersions(database.pool, ra, saved.json().documentId);
    expect(versions.items).toHaveLength(1);
    expect(versions.items[0]).toMatchObject({
      dataLevel: 'internal',
      parseStatus: { state: 'queued' },
    });
    holdUploads = true;
    const pending = ['fixture-2.pdf', 'fixture-3.pdf'].map((name) => submit(true, true, name));
    await bothStoring;
    try {
      expect((await submit(true, true, 'fixture-busy.pdf')).statusCode).toBe(429);
    } finally {
      releaseUploads();
      await Promise.all(pending);
    }
    holdUploads = false;
    expect((await submit(true, true, 'fixture-busy.pdf')).statusCode).toBe(202);
  } finally {
    await Promise.all([app.close(), disabled.close()]);
  }
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

test('成员可共享资料，检索仍按项目隔离，作废后不能读取或重新导入恢复', async () => {
  const input = source('VOID-01', 'VOID_UNIQUE 原文');
  const document = await ingestParsedDocument(database.pool, blobs.store, input);
  expect((await getDocument(database.pool, memberB, document.documentId)).id).toBe(
    document.documentId,
  );
  expect(
    (await readDocumentPage(database.pool, memberB, document.documentId, 1, 1)).text,
  ).toContain('VOID_UNIQUE');
  expect(
    (await searchDocuments(database.pool, memberB, otherProjectId, { query: 'VOID_UNIQUE' })).items,
  ).toHaveLength(0);
  await database.pool.query("UPDATE app_user SET status='disabled' WHERE id=$1", [memberB.userId]);
  try {
    await expect(getDocument(database.pool, memberB, document.documentId)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      searchDocuments(database.pool, memberB, projectId, { query: 'VOID_UNIQUE' }),
    ).rejects.toMatchObject({ statusCode: 403 });
  } finally {
    await database.pool.query("UPDATE app_user SET status='active' WHERE id=$1", [memberB.userId]);
  }
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
