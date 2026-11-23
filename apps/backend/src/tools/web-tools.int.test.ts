import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  fetcherSnapshotSchema,
  identifierCheckResultSchema,
  officialLookupResultSchema,
  webFetchResultSchema,
  webSearchResultSchema,
  type PermissionMode,
} from '@cert-board/shared';
import type { z } from 'zod';
import { createApp } from '../app.js';
import { AppError } from '../api/errors.js';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import { FetcherRedirect } from '../documents/fetcher-client.js';
import { importVerifiedLicenceLedger } from '../documents/licence-ledger-import.js';
import { ingestParsedDocument } from '../documents/service.js';
import { createIntegrationContext } from '../test-support/context.js';
import { docReadTool } from './doc-read.js';
import { identifierCheckTool } from './identifier-check.js';
import { ToolRegistry } from './registry.js';
import { buildWebTools } from './web-tools.js';

const url = 'https://www.fda.gov/medical-devices/example';
const raw = Buffer.from('<title>示例指南</title><p>这是一句可溯源的合成原文。</p>');
const text = '这是一句可溯源的合成原文。';
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function snapshot(
  fetchedAt = new Date().toISOString(),
  body = raw,
): z.infer<typeof fetcherSnapshotSchema> {
  return {
    url,
    title: '示例指南',
    text,
    truncated: false,
    mediaType: 'text/html',
    fetchedAt,
    sha256: digest(body),
    bodyBase64: body.toString('base64'),
  };
}

class MemoryStore implements DocumentBlobStore {
  readonly blobs = new Map<string, Buffer>();
  async put(body: Buffer) {
    const sha256 = digest(body);
    this.blobs.set(sha256, Buffer.from(body));
    return { sha256, byteSize: body.byteLength };
  }
  async get(sha256: string) {
    const body = this.blobs.get(sha256);
    if (!body) throw new Error('TEST_BLOB_MISSING');
    return body;
  }
}

let context: Awaited<ReturnType<typeof createIntegrationContext>>;
beforeEach(async () => {
  context = await createIntegrationContext();
});
afterEach(async () => {
  await context.close();
});

async function scenario(mode: PermissionMode = 'full') {
  const store = new MemoryStore();
  const run = await context.run('MEMBER_A', mode);
  const client = {
    fetchPage: vi.fn(async (_url: string) => snapshot()),
    search: vi.fn(async () => ({
      items: [
        { url, title: '官方样例', snippet: '合成检索结果' },
        { url: 'https://reference-source.org/', title: '扩展样例', snippet: '' },
        { url: 'https://ordinary-source.org/', title: '普通样例', snippet: '' },
      ],
    })),
  };
  const registry = new ToolRegistry(context.pool, [
    ...buildWebTools(context.pool, store, client, ['reference-source.org']),
    docReadTool(),
    identifierCheckTool(),
  ]);
  const invoke = (name: string, input: object, callId = randomUUID()) =>
    registry.execute({ runId: run.runId, userId: run.userId, callId }, name, input);
  return { store, client, invoke, run, registry };
}

function officialSnapshot(officialUrl: string, payload: unknown) {
  const bytes = Buffer.from(JSON.stringify(payload));
  return {
    ...snapshot(new Date().toISOString(), bytes),
    url: officialUrl,
    mediaType: 'application/json' as const,
  };
}

const officialInput = { dataset: 'fda_510k', kNumber: 'K170825' };
const officialClearance = {
  k_number: 'K170825',
  decision_date: '2017-08-18',
  product_code: 'LRK',
  openfda: { device_class: '2', regulation_number: '872.5570' },
};

test('官方回查通过工具注册执行，存档原始响应并复用同项目缓存', async () => {
  const { store, client, invoke } = await scenario();
  const payload = { meta: { results: { total: 1 } }, results: [officialClearance] };
  client.fetchPage.mockImplementation(async (address) => officialSnapshot(address, payload));
  const initial = officialLookupResultSchema.parse((await invoke('official_lookup', officialInput)).data);
  if (initial.status !== 'ok' || !initial.evidence) throw new Error('缺少公开资料存档');
  expect(initial).toMatchObject({
    cached: false,
    records: [{ identifier: 'K170825', productCode: 'LRK', regulationNumber: '872.5570', deviceClass: '2' }],
    evidence: { page: 1, archive: { mediaType: 'application/json', sourceType: 'official' } },
  });
  expect(await store.get(initial.evidence.archive.sha256)).toEqual(Buffer.from(JSON.stringify(payload)));
  const repeated = officialLookupResultSchema.parse((await invoke('official_lookup', officialInput)).data);
  expect(repeated).toEqual({ ...initial, cached: true });
  expect(client.fetchPage).toHaveBeenCalledTimes(1);
});

test('V2 用官方存档字段和材料原文发现 K 号对调，拒绝缺失的引文', async () => {
  const { store, client, invoke } = await scenario();
  const sourceText = '对比器械编号 K170285。';
  const doc = await ingestParsedDocument(context.pool, store, {
    projectId: context.projectId,
    sourceKey: 'PR30-FIXTURE',
    name: '合成材料',
    sourcePath: 'pr30-fixture.txt',
    sourceSnapshot: digest(Buffer.from(sourceText)),
    originalSha256: null,
    dataLevel: 'internal',
    authorType: 'external',
    sourceMetadata: {},
    pages: [{
      pageNumber: 1,
      text: sourceText,
      method: 'text',
      locatorKind: 'extraction_unit',
      isPlaceholder: false,
    }],
  });
  const payload = { meta: { results: { total: 1 } }, results: [officialClearance] };
  client.fetchPage.mockImplementation(async (address) => officialSnapshot(address, payload));
  const lookup = officialLookupResultSchema.parse((await invoke('official_lookup', officialInput)).data);
  if (lookup.status !== 'ok' || !lookup.evidence) throw new Error('缺少官方验证快照');
  const { documentId, version, page } = lookup.evidence;
  const request = {
    field: 'k_number',
    referenceType: 'official',
    observed: { identifier: 'K170285', evidence: { documentId: doc.documentId, version: doc.version, page: 1, quote: sourceText } },
    references: [{ identifier: 'K170825', evidence: { documentId, version, page, quote: '"identifier": "K170825"' } }],
  };
  const checked = await invoke('identifier_check', request);
  const result = identifierCheckResultSchema.parse(checked.data);
  expect(result).toMatchObject({
    status: 'possible_typo',
    candidates: [{ identifier: 'K170825', edits: 1 }],
    observed: { identifier: 'K170285' },
  });
  await expect(
    invoke('identifier_check', {
      ...request,
      observed: { ...request.observed, evidence: { ...request.observed.evidence, quote: '不存在的 K170285' } },
    }),
  ).resolves.toMatchObject({ data: { status: 'unavailable', code: 'V2_EVIDENCE_MISMATCH' } });
  await expect(invoke('identifier_check', {
    ...request,
    referenceType: 'ledger',
    references: [request.observed],
  })).resolves.toMatchObject({ data: { status: 'unavailable', code: 'V2_LEDGER_SOURCE_REQUIRED' } });
  const ledgerText = '证照台账 对比器械编号 K170825。';
  const ledgerDraft = {
    projectId: context.projectId, sourceKey: 'PR30-LEDGER', name: '合成证照台账',
    sourcePath: 'pr30-ledger.txt', sourceSnapshot: digest(Buffer.from(ledgerText)),
    dataLevel: 'internal', authorType: 'human',
    pages: [{ pageNumber: 1, text: ledgerText, method: 'text', locatorKind: 'extraction_unit' }],
  };
  const previous = await ingestParsedDocument(context.pool, store, ledgerDraft);
  const ledgerRequest = (ref: { documentId: string; version: number }) => ({
    ...request,
    referenceType: 'ledger',
    references: [{ identifier: 'K170825', evidence: {
      documentId: ref.documentId, version: ref.version, page: 1, quote: ledgerText,
    } }],
  });
  await expect(invoke('identifier_check', ledgerRequest(previous))).resolves.toMatchObject({
    data: { status: 'unavailable', code: 'V2_LEDGER_SOURCE_REQUIRED' },
  });
  const ledger = await importVerifiedLicenceLedger(context.pool, store, ledgerDraft);
  expect(ledger).toMatchObject({ documentId: previous.documentId, version: previous.version + 1 });
  await expect(invoke('identifier_check', ledgerRequest(ledger))).resolves.toMatchObject({
    data: { status: 'possible_typo' },
  });
  await expect(importVerifiedLicenceLedger(context.pool, store, ledgerDraft)).resolves.toMatchObject({
    version: ledger.version, created: false,
  });
});

test('截止日回查的可下载存档不带未来记录，只读查询不写入', async () => {
  const request = { ...officialInput, asOf: '2017-08-18' };
  const payload = {
    meta: { results: { total: 2 } },
    results: [
      officialClearance,
      { ...officialClearance, decision_date: '2029-01-01', device_name: '未来合成版本' },
    ],
  };
  const saving = await scenario();
  saving.client.fetchPage.mockImplementation(async (address) => officialSnapshot(address, payload));
  const out = officialLookupResultSchema.parse((await saving.invoke('official_lookup', request)).data);
  if (out.status !== 'ok' || !out.evidence) throw new Error('缺少截止日存档');
  expect(out.records).toHaveLength(1);
  const stored = (await saving.store.get(out.evidence.archive.sha256)).toString('utf8');
  expect(stored).not.toContain('未来合成版本');
  expect(stored).not.toContain('2029-01-01');
  const preview = await scenario('read_only');
  const other = { ...officialInput, kNumber: 'K253845' };
  preview.client.fetchPage.mockImplementation(async (address) =>
    officialSnapshot(address, { ...payload, results: [{ ...officialClearance, k_number: other.kNumber }] }),
  );
  expect((await preview.invoke('official_lookup', other)).data).toMatchObject({
    status: 'ok',
    evidence: null,
    records: [{ identifier: other.kNumber }],
    cached: false,
  });
  expect(preview.store.blobs.size).toBe(0);
});

test('官方数据回查在保密对话中停止于出网之前', async () => {
  const { store, client, invoke, run } = await scenario();
  await context.pool.query("UPDATE run SET max_data_level='confidential' WHERE id=$1", [run.runId]);
  const output = await invoke('official_lookup', officialInput);
  expect(output.data).toMatchObject({ status: 'unavailable', code: 'WEB_CONFIDENTIAL_BLOCKED' });
  expect(client.fetchPage).not.toHaveBeenCalled();
  expect(store.blobs.size).toBe(0);
});

test('公开网页原件可用浏览器会话下载，页码原文与缓存稳定可重放', async () => {
  const { store, client, invoke } = await scenario();
  const operation = randomUUID();
  const first = await invoke('web_fetch', { url }, operation);
  const saved = webFetchResultSchema.parse(first.data);
  if ('status' in saved) throw new Error(saved.status);
  expect(saved).toMatchObject({
    archive: { url, sha256: digest(raw), sourceType: 'official' },
    page: 1,
    cached: false,
  });
  expect((await invoke('web_fetch', { url }, operation)).replayed).toBe(true);
  expect((await invoke('web_fetch', { url })).data).toMatchObject({
    documentId: saved.documentId,
    version: 1,
    cached: true,
  });
  expect(client.fetchPage).toHaveBeenCalledTimes(1);
  expect(
    (await invoke('doc_read', { id: saved.documentId, version: 1, page: 1 })).data,
  ).toMatchObject({
    text,
    warning: '当前提供网页存档提取文本。 此段对应网页文本提取单元。',
    webArchive: { sha256: digest(raw) },
  });

  const app = createApp(context.config, {
    database: context.pool,
    blobStore: store,
    close: async () => undefined,
    checkDatabase: async () => undefined,
    checkStorage: async () => undefined,
  });
  try {
    const headers = (await context.login('MEMBER_B')).headers;
    const endpoint = `/api/documents/${saved.documentId}/versions/1/web-archive`;
    expect((await app.inject({ url: endpoint })).statusCode).toBe(403);
    const metadata = await app.inject({ url: `${endpoint}-info`, headers });
    expect(metadata.json()).toMatchObject({ sha256: digest(raw), url, mediaType: 'text/html' });
    const download = await app.inject({ url: endpoint, headers });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-disposition']).toMatch(/^attachment;/u);
    expect(download.headers['content-type']).toBe('application/octet-stream');
    expect(download.rawPayload).toEqual(raw);
  } finally {
    await app.close();
  }
});

test('只读会话只取临时预览，不写入资料库或原件存储', async () => {
  const { client, store, invoke } = await scenario('read_only');
  const result = await invoke('web_fetch', { url });
  expect(result.data).toMatchObject({ status: 'read_only', preview: text, url, truncated: false });
  expect(result.data).not.toHaveProperty('documentId');
  expect(result.data).not.toHaveProperty('archive');
  expect(client.fetchPage).toHaveBeenCalledOnce();
  expect(store.blobs.size).toBe(0);
  expect(
    (await context.pool.query("SELECT 1 FROM document WHERE source_key LIKE 'W-%'")).rowCount,
  ).toBe(0);
});

test('只读会话复用已有页面并提示截断，无须重新出网', async () => {
  const { client, invoke, registry } = await scenario('full');
  client.fetchPage.mockResolvedValueOnce({ ...snapshot(), text: '公'.repeat(5000) });
  expect((await invoke('web_fetch', { url })).data).toMatchObject({ cached: false });
  client.fetchPage.mockRejectedValue(
    new AppError(502, 'FETCH_PROXY_UNAVAILABLE', '仅允许读取缓存。'),
  );
  const reader = await context.run('MEMBER_B', 'read_only');
  const result = await registry.execute(
    { runId: reader.runId, userId: reader.userId, callId: randomUUID() },
    'web_fetch',
    { url },
  );
  expect(result.data).toMatchObject({
    status: 'read_only',
    truncated: true,
    preview: '公'.repeat(4000),
  });
  expect(result.data).not.toHaveProperty('archive');
  expect(client.fetchPage).toHaveBeenCalledOnce();
});

test('请求批准模式可存档证据，跳转与提取上限给出不同的下一步', async () => {
  const { client, invoke } = await scenario('ask');
  const candidate = 'https://www.fda.gov/latest';
  client.fetchPage.mockRejectedValueOnce(new FetcherRedirect(candidate));
  expect((await invoke('web_fetch', { url })).data).toMatchObject({
    status: 'unavailable',
    code: 'FETCH_REDIRECT',
    nextUrl: candidate,
  });
  expect(client.fetchPage).toHaveBeenCalledOnce();
  client.fetchPage.mockResolvedValueOnce({ ...snapshot(), truncated: true });
  expect(await invoke('web_fetch', { url })).toMatchObject({
    status: 'completed',
    data: { archive: { extractedTruncated: true }, guidance: expect.stringContaining('人工核对') },
  });
});

test('检索词脱敏，来源政策只标记类别，含保密词的网址不派发', async () => {
  const { client, invoke } = await scenario();
  const actor = await context.login();
  expect(
    (
      await context.app.inject({
        url: '/api/external-model/words',
        method: 'POST',
        headers: actor.headers,
        payload: { phrase: '合成客户甲', category: 'customer' },
      })
    ).statusCode,
  ).toBe(200);
  const searched = webSearchResultSchema.parse(
    (await invoke('web_search', { query: '查询合成客户甲公开要求' })).data,
  );
  if ('status' in searched) throw new Error(searched.code);
  expect(searched.items.map(({ sourceType }) => sourceType)).toEqual([
    'official',
    'extended',
    'general',
  ]);
  expect(searched.redactions).toBe(1);
  expect(client.search).toHaveBeenCalledWith(expect.stringContaining('[[CB-'), 5, undefined);
  expect(JSON.stringify(client.search.mock.calls)).not.toContain('合成客户甲');
  expect(
    (await invoke('web_fetch', { url: `${url}/${encodeURIComponent('合成客户甲')}` })).data,
  ).toMatchObject({ status: 'unavailable', code: 'WEB_ADDRESS_REJECTED' });
  expect(client.fetchPage).not.toHaveBeenCalled();
});

test('保密对话和私有地址均不触发外部请求', async () => {
  const { client, run, invoke } = await scenario();
  expect((await invoke('web_fetch', { url: 'https://127.0.0.1/' })).data).toMatchObject({
    code: 'WEB_URL_INVALID',
  });
  expect(
    (await invoke('web_fetch', { url: `${url}?%58-Amz-Signature=fixture-only` })).data,
  ).toMatchObject({ code: 'WEB_URL_INVALID' });
  await context.pool.query("UPDATE conversation SET max_data_level='confidential' WHERE id=$1", [
    run.conversationId,
  ]);
  for (const [name, input] of [
    ['web_fetch', { url }],
    ['web_search', { query: '公开流程' }],
  ] as const)
    expect((await invoke(name, input)).data).toMatchObject({ code: 'WEB_CONFIDENTIAL_BLOCKED' });
  expect(client.fetchPage).not.toHaveBeenCalled();
  expect(client.search).not.toHaveBeenCalled();
});

test('快照到期后创建下一版本，原始证据保留', async () => {
  const { client, invoke } = await scenario();
  client.fetchPage.mockResolvedValueOnce(
    snapshot(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()),
  );
  const first = webFetchResultSchema.parse((await invoke('web_fetch', { url })).data);
  if ('status' in first) throw new Error(first.status);
  expect((await invoke('web_fetch', { url })).data).toMatchObject({
    documentId: first.documentId,
    version: 2,
    cached: false,
  });
  expect(client.fetchPage).toHaveBeenCalledTimes(2);
  expect(
    (
      await context.pool.query('SELECT id FROM document_version WHERE document_id=$1', [
        first.documentId,
      ])
    ).rowCount,
  ).toBe(2);
});

test('抓取传输失败也保留次数记录，避免重复派发超过预算', async () => {
  const { client, invoke } = await scenario();
  client.fetchPage.mockRejectedValue(
    new AppError(503, 'FETCHER_UNAVAILABLE', '抓取代理暂不可用，请改用资料库。'),
  );
  for (let attempt = 0; attempt < 8; attempt++)
    expect((await invoke('web_fetch', { url })).data).toMatchObject({
      status: 'unavailable',
      code: 'FETCHER_UNAVAILABLE',
    });
  expect((await invoke('web_fetch', { url })).data).toMatchObject({
    status: 'unavailable',
    code: 'WEB_LIMIT_REACHED',
  });
  expect(client.fetchPage).toHaveBeenCalledTimes(8);
});

test('哈希校验失败不写资料，PDF 原件送存档时标为未解析', async () => {
  const { client, invoke } = await scenario();
  client.fetchPage.mockResolvedValueOnce({ ...snapshot(), sha256: '0'.repeat(64) });
  expect((await invoke('web_fetch', { url })).data).toMatchObject({
    status: 'unavailable',
    code: 'WEB_SNAPSHOT_INVALID',
  });
  client.fetchPage.mockRejectedValueOnce(
    new AppError(502, 'FETCH_BODY_INCOMPLETE', '响应不完整。'),
  );
  expect((await invoke('web_fetch', { url })).data).toMatchObject({
    code: 'FETCH_BODY_INCOMPLETE',
  });
  expect(
    (await context.pool.query("SELECT id FROM document WHERE source_key LIKE 'W-%'")).rowCount,
  ).toBe(0);
  client.fetchPage.mockResolvedValueOnce({
    ...snapshot(undefined, Buffer.from('%PDF-1.7')),
    mediaType: 'application/pdf',
    text: '',
  });
  const archived = webFetchResultSchema.parse((await invoke('web_fetch', { url })).data);
  if ('status' in archived) throw new Error(archived.status);
  expect(archived.page).toBeNull();
  const actor = await context.login();
  const placeholder = await context.app.inject({
    url: `/api/documents/${archived.documentId}/versions/1/pages/1`,
    headers: actor.headers,
  });
  const metadata = await context.app.inject({
    url: `/api/documents/${archived.documentId}/versions/1/web-archive-info`,
    headers: actor.headers,
  });
  expect(placeholder.statusCode).toBe(422);
  expect(metadata.json()).toMatchObject({ mediaType: 'application/pdf' });
});
