import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  docsvcBaseUrl,
  documentFormatSchema,
  documentLocatorKindSchema,
  documentPageMethodSchema,
  documentPageSourceSchema,
  isPdfReaderPlaceholder,
  sha256Schema,
  type BackendConfig,
  type DocumentFormat,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';

export const maximumDocumentBytes = 96 * 1024 * 1024;
const maximumResponseBytes = 150 * 1024 * 1024;
const maximumPages = 800;
const maximumXfaBytes = 5 * 1024 * 1024;
const parseResponse = z.object({
  sha256: sha256Schema,
  kind: documentFormatSchema,
  byteSize: z.number().int().min(1).max(maximumDocumentBytes),
  pageCount: z.number().int().min(1).max(maximumPages),
  pages: z
    .array(
      z.object({
        page: z.number().int().min(1).max(maximumPages),
        method: documentPageMethodSchema,
        locatorKind: documentLocatorKindSchema,
        text: z.string().max(1_000_000),
        ocrScore: z.number().finite().min(0).max(1).optional(),
      }),
    )
    .min(1)
    .max(maximumPages),
});
const parserError = z.object({ code: z.string().regex(/^DOC_[A-Z0-9_]{1,60}$/u) });
const attachmentResponse = z.object({
  attachments: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        sourceNames: z.array(z.string().max(200)).max(128).default([]),
        sha256: sha256Schema,
        byteSize: z.number().int().nonnegative().max(maximumDocumentBytes),
        bodyBase64: z.string().max(128 * 1024 * 1024),
      }),
    )
    .max(64),
});
const invalid = () =>
  new AppError(502, 'DOC_RESPONSE_INVALID', '解析结果校验失败，请联系维护人员检查文档服务。');

async function readJson(response: Response, maximum: number): Promise<unknown> {
  if (!response.body || Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel();
    throw invalid();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) throw invalid();
      chunks.push(part.value);
    }
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)),
      ) as unknown;
    } catch {
      throw invalid();
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class DocumentParserClient {
  readonly #address: string;

  constructor(address: string, runtime: BackendConfig['CONTAINER_RUNTIME']) {
    const expected = docsvcBaseUrl(runtime);
    if (!URL.canParse(address) || new URL(address).href !== expected)
      throw new AppError(500, 'DOCSVC_CONFIG_INVALID', '解析服务只能使用本部署的固定内部地址。');
    this.#address = expected;
  }

  async #request(
    action: 'parse' | 'inspect',
    content: Buffer,
    sha256: string,
    format: DocumentFormat,
    signal?: AbortSignal,
  ) {
    if (
      !content.length ||
      content.length > maximumDocumentBytes ||
      createHash('sha256').update(content).digest('hex') !== sha256
    )
      throw new AppError(
        422,
        'DOC_SOURCE_INTEGRITY',
        '资料原件大小或哈希不符合已登记版本，无法解析。',
      );
    const deadline = AbortSignal.timeout(action === 'inspect' ? 40_000 : 400_000);
    try {
      const url = new URL(action, this.#address);
      url.searchParams.set('kind', format);
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        headers: { 'content-type': 'application/octet-stream', 'x-content-sha256': sha256 },
        body: Buffer.from(content),
      });
      const raw = await readJson(
        response,
        response.ok && action === 'parse' ? maximumResponseBytes : 4_096,
      );
      if (!response.ok) {
        const error = parserError.safeParse(raw);
        throw new AppError(
          response.status,
          error.success ? error.data.code : 'DOC_PARSE_FAILED',
          '解析服务暂未完成该资料。请检查资料版本的解析状态。',
        );
      }
      return raw;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, 'DOCSVC_UNAVAILABLE', '解析服务暂不可用，请检查本机解析服务后重试。');
    }
  }

  async #parsed(content: Buffer, sha256: string, format: DocumentFormat, signal?: AbortSignal) {
    const raw = await this.#request('parse', content, sha256, format, signal);
    const parsed = parseResponse.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.sha256 !== sha256 ||
      parsed.data.kind !== format ||
      parsed.data.byteSize !== content.length ||
      parsed.data.pageCount !== parsed.data.pages.length
    )
      throw invalid();
    return { raw, document: parsed.data };
  }

  async inspectPdf(content: Buffer, sha256: string, signal?: AbortSignal) {
    const raw = await this.#request('inspect', content, sha256, 'pdf', signal);
    const result = z
      .object({
        sha256: sha256Schema,
        byteSize: z.number().int(),
        kind: z.enum(['pdf', 'estar']),
      })
      .safeParse(raw);
    if (!result.success || result.data.sha256 !== sha256 || result.data.byteSize !== content.length)
      throw invalid();
    return result.data.kind;
  }

  async parse(content: Buffer, sha256: string, format: DocumentFormat, signal?: AbortSignal) {
    const { document } = await this.#parsed(content, sha256, format, signal);
    const method = format === 'xlsx' ? 'xlsx' : 'docx';
    const physical = format === 'pdf' || format === 'estar';
    return document.pages.map((page, index) => {
      if (
        page.page !== index + 1 ||
        (physical
          ? page.locatorKind !== 'physical_page' || !['text', 'ocr'].includes(page.method)
          : page.locatorKind !== 'extraction_unit' || page.method !== method) ||
        (page.method === 'ocr') !== (page.ocrScore !== undefined) ||
        page.text.includes('\0')
      )
        throw invalid();
      const result = documentPageSourceSchema.safeParse({
        pageNumber: page.page,
        method: page.method,
        text: page.text,
        locatorKind: page.locatorKind,
        ocrScore: page.ocrScore ?? null,
        isPlaceholder: physical && isPdfReaderPlaceholder(page.text),
      });
      if (!result.success) throw invalid();
      return result.data;
    });
  }

  async estarAttachments(content: Buffer, sha256: string, signal?: AbortSignal) {
    const { raw } = await this.#parsed(content, sha256, 'estar', signal);
    const result = attachmentResponse.safeParse(raw);
    if (!result.success) throw invalid();
    let total = 0;
    return result.data.attachments.map((item) => {
      total += item.byteSize;
      if (total > 80 * 1024 * 1024 || item.bodyBase64.length !== Math.ceil(item.byteSize / 3) * 4)
        throw invalid();
      const bytes = Buffer.from(item.bodyBase64, 'base64');
      if (
        bytes.length !== item.byteSize ||
        createHash('sha256').update(bytes).digest('hex') !== item.sha256
      )
        throw invalid();
      return { name: item.name, sourceNames: item.sourceNames, sha256: item.sha256, bytes };
    });
  }

  async estarDatasets(content: Buffer, sha256: string, signal?: AbortSignal) {
    const { raw } = await this.#parsed(content, sha256, 'estar', signal);
    const value = z.object({
      xfaDatasetsBase64: z.string().max(Math.ceil(maximumXfaBytes / 3) * 4).nullable().optional(),
    }).safeParse(raw);
    if (!value.success) throw invalid();
    const base64 = value.data.xfaDatasetsBase64;
    if (!base64) return null;
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > maximumXfaBytes || bytes.toString('base64') !== base64) throw invalid();
    const listing = attachmentResponse.safeParse(raw);
    if (!listing.success) throw invalid();
    const attachmentNames = [...new Set(listing.data.attachments.flatMap(
      ({ name, sourceNames }) => [name, ...sourceNames],
    ))];
    if (attachmentNames.length > 256) return null;
    return { bytes, attachmentNames };
  }
}
