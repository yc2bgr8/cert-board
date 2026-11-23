import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import {
  developmentProjectSeedConfigSchema,
  isPdfReaderPlaceholder,
  t1DocumentsSchema,
  t1PageSchema,
} from '@cert-board/shared';
import { DevelopmentSeedError } from '../db/seed.js';
import { developmentProjectId } from '../projects/seed.js';
import type { BlobStore } from './blob-store.js';
import { ingestParsedDocument } from './service.js';

const defaultDirectory = fileURLToPath(new URL('../../../../fixtures/l08/t1_out/', import.meta.url));

export async function readT1Fixture(
  directory = defaultDirectory,
) {
  const [documentText, pageText] = await Promise.all([
    readFile(path.join(directory, 'documents.json'), 'utf8'),
    readFile(path.join(directory, 'pages.jsonl'), 'utf8'),
  ]);
  let rawDocuments: unknown;
  let rawPages: unknown[];
  try {
    rawDocuments = JSON.parse(documentText);
    rawPages = pageText
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch {
    throw new DevelopmentSeedError(
      'T1快照JSON无法解析，请检查fixtures/l08/t1_out；未输出资料正文。',
    );
  }
  const documents = t1DocumentsSchema.safeParse(rawDocuments);
  const pages = rawPages.map((page) => t1PageSchema.safeParse(page));
  if (!documents.success || pages.some((page) => !page.success))
    throw new DevelopmentSeedError('T1快照字段无效，请核对资料清单与逐页记录。');
  const parsedPages = pages.map((page) => {
    if (!page.success) throw new Error('invalid_page');
    return page.data;
  });
  const ids = new Set(documents.data.map((doc) => doc.id));
  const pageIds = new Set(parsedPages.map((page) => `${page.doc}:${page.page}`));
  if (
    ids.size !== documents.data.length ||
    pageIds.size !== parsedPages.length ||
    parsedPages.some((page) => !ids.has(page.doc))
  ) {
    throw new DevelopmentSeedError('T1快照包含重复或未知资料/页码，请核对后重试。');
  }
  for (const doc of documents.data) {
    const numbered = parsedPages
      .filter((page) => page.doc === doc.id)
      .sort((a, b) => a.page - b.page);
    if (numbered.length !== doc.pages || numbered.some((page, index) => page.page !== index + 1))
      throw new DevelopmentSeedError(`T1资料${doc.id}的页数或页码不完整，请核对快照。`);
  }
  const snapshot = createHash('sha256')
    .update(documentText.replaceAll('\r\n', '\n'))
    .update('\0')
    .update(pageText.replaceAll('\r\n', '\n'))
    .digest('hex');
  return { documents: documents.data, pages: parsedPages, snapshot };
}

export async function seedT1Documents(
  pool: pg.Pool,
  store: BlobStore,
  environment: Record<string, unknown>,
  directory?: string,
) {
  if (!developmentProjectSeedConfigSchema.safeParse(environment).success)
    throw new DevelopmentSeedError('T1开发种子只允许development/test环境运行。');
  const fixture = await readT1Fixture(directory);
  const roots = fixture.documents.filter((doc) =>
    doc.ext === '.pdf' && fixture.documents.some((child) => child.parent === doc.id),
  );
  const datasets = roots.length === 1
    ? await readFile(path.join(directory ?? defaultDirectory, 'estar_datasets.xml')).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    })
    : null;
  if (datasets && datasets.length > 5 * 1024 * 1024)
    throw new DevelopmentSeedError('T1 的 eSTAR 数据集超过大小上限。');
  const xfaBlob = datasets ? await store.put(datasets) : null;
  for (const doc of fixture.documents) {
    const xfa = xfaBlob && doc.id === roots[0]?.id ? xfaBlob.sha256 : undefined;
    const pages = fixture.pages
      .filter((page) => page.doc === doc.id)
      .sort((a, b) => a.page - b.page)
      .map((page) => ({
        pageNumber: page.page,
        text: page.text,
        method: page.method,
        locatorKind: page.method === 'docx' ? 'extraction_unit' : 'physical_page',
        ocrScore: page.ocr_score ?? null,
        isPlaceholder: isPdfReaderPlaceholder(page.text),
      }));
    await ingestParsedDocument(pool, store, {
      projectId: developmentProjectId,
      sourceKey: doc.id,
      name: doc.name.normalize('NFC'),
      sourcePath: doc.path.normalize('NFC'),
      sourceSnapshot: xfa
        ? createHash('sha256').update(fixture.snapshot).update(xfa).digest('hex')
        : fixture.snapshot,
      originalSha256: doc.sha256,
      dataLevel: 'internal',
      authorType: 'external',
      pages,
      sourceMetadata: {
        importKind: 't1_snapshot',
        sourceVersionLabel: '本次T1快照导入版本，非源文件修订号',
        originalName: doc.name,
        originalPath: doc.path,
        sourceType: doc.source_type,
        parentSourceKey: doc.parent,
        duplicateOf: doc.duplicate_of,
        originalByteSize: doc.bytes,
        extension: doc.ext,
        parserReportedStatus: doc.status,
        originalFileStored: false,
        originalHashProvenance: 'T1清单；本次未重算原文件哈希',
        ...(xfa ? {
          xfaDatasetsSha256: xfa,
          xfaAttachmentNames: fixture.documents.filter((child) => child.parent === doc.id)
            .map((child) => child.name.normalize('NFC')),
        } : {}),
      },
    });
  }
  return {
    documentCount: fixture.documents.length,
    pageCount: fixture.pages.length,
    snapshot: fixture.snapshot,
  };
}
