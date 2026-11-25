import { createHash } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { DocumentParserClient } from './docsvc-client.js';

const address = 'http://127.0.0.1:28082';
const bytes = Buffer.from('%PDF-1.4 fictional fixture');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const parsed = {
  sha256,
  kind: 'pdf',
  byteSize: bytes.length,
  pageCount: 1,
  pages: [
    {
      page: 1,
      method: 'ocr',
      locatorKind: 'physical_page',
      text: '识别页 fixture',
      ocrScore: 0.81,
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

test('从固定 Word 对比入口读取有顺序的段落并校验哈希', async () => {
  const paragraphs = ['首段\n段内换行', '表格 | 行', '末段'];
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ sha256, pageCount: 1, paragraphs }))
    .mockResolvedValueOnce(Response.json({ sha256: 'a'.repeat(64), pageCount: 1, paragraphs }));
  vi.stubGlobal('fetch', fetch);
  const client = new DocumentParserClient(address, 'host');
  await expect(client.wordParagraphs(bytes, sha256)).resolves.toEqual(paragraphs);
  expect(fetch).toHaveBeenCalledWith(
    new URL('/text?kind=docx', address),
    expect.objectContaining({ body: bytes }),
  );
  await expect(client.wordParagraphs(bytes, sha256)).rejects.toMatchObject({
    code: 'DOC_RESPONSE_INVALID',
  });
});

test('上传原件、校验返回哈希与页，并保留 OCR 置信度', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json(parsed));
  vi.stubGlobal('fetch', fetch);
  await expect(
    new DocumentParserClient(address, 'host').parse(bytes, sha256, 'pdf'),
  ).resolves.toEqual([
    {
      pageNumber: 1,
      method: 'ocr',
      locatorKind: 'physical_page',
      text: '识别页 fixture',
      ocrScore: 0.81,
      isPlaceholder: false,
    },
  ]);
  expect(fetch).toHaveBeenCalledWith(
    new URL('/parse?kind=pdf', address),
    expect.objectContaining({
      redirect: 'error',
      headers: { 'content-type': 'application/octet-stream', 'x-content-sha256': sha256 },
      body: bytes,
    }),
  );
});

test('拒绝非固定端点和错误原件，拒绝不连续的输出页码', async () => {
  expect(() => new DocumentParserClient('https://example.invalid/', 'host')).toThrow();
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      ...parsed,
      pages: [{ ...parsed.pages[0], page: 2 }],
    }),
  );
  vi.stubGlobal('fetch', fetch);
  const client = new DocumentParserClient(address, 'host');
  await expect(client.parse(bytes, 'a'.repeat(64), 'pdf')).rejects.toMatchObject({
    code: 'DOC_SOURCE_INTEGRITY',
  });
  expect(fetch).not.toHaveBeenCalled();
  await expect(client.parse(bytes, sha256, 'pdf')).rejects.toMatchObject({
    code: 'DOC_RESPONSE_INVALID',
  });
});

test('保留安全的繁忙代码并限制错误响应正文大小', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ code: 'DOC_BUSY', trace: 'private fixture' }, { status: 429 }),
    )
    .mockResolvedValueOnce(new Response('x'.repeat(5_000), { status: 500 }));
  vi.stubGlobal('fetch', fetch);
  const client = new DocumentParserClient(address, 'host');
  await expect(client.parse(bytes, sha256, 'pdf')).rejects.toMatchObject({
    code: 'DOC_BUSY',
    statusCode: 429,
  });
  await expect(client.parse(bytes, sha256, 'pdf')).rejects.toMatchObject({
    code: 'DOC_RESPONSE_INVALID',
  });
});

test('PDF 阅读器提示保留占位标记，不能成为检索证据', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        ...parsed,
        kind: 'estar',
        pages: [
          {
            page: 1,
            method: 'text',
            locatorKind: 'physical_page',
            text: 'Please wait... Open this form in Adobe.',
          },
        ],
      }),
    ),
  );
  const client = new DocumentParserClient(address, 'host');
  await expect(client.parse(bytes, sha256, 'estar')).resolves.toEqual([
    expect.objectContaining({ pageNumber: 1, isPlaceholder: true }),
  ]);
});

test('eSTAR 规则提取同一原件的数据集和附件名，并拒绝不规范的编码', async () => {
  const datasets = Buffer.from('<xfa>please see: MSDS</xfa>');
  const data = {
    ...parsed,
    kind: 'estar',
    xfaDatasetsBase64: datasets.toString('base64'),
    attachments: [
      {
        name: 'Instructions.pdf',
        sourceNames: ['Instructions (original).pdf'],
        sha256,
        byteSize: bytes.length,
        bodyBase64: bytes.toString('base64'),
      },
    ],
  };
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json(data))
      .mockResolvedValueOnce(Response.json({ ...data, xfaDatasetsBase64: '@@' })),
  );
  const client = new DocumentParserClient(address, 'host');
  await expect(client.estarDatasets(bytes, sha256)).resolves.toEqual({
    bytes: datasets,
    attachmentNames: ['Instructions.pdf', 'Instructions (original).pdf'],
  });
  await expect(client.estarDatasets(bytes, sha256)).rejects.toMatchObject({
    code: 'DOC_RESPONSE_INVALID',
  });
});
