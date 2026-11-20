import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { webArchiveInfoSchema, type WebArchiveInfo } from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import type { DocumentBlobStore } from './blob-store.js';
import type { FetcherClient } from './fetcher-client.js';
import { ingestParsedDocument } from './service.js';

const officialHosts = [
  'fda.gov',
  'canada.ca',
  'ecfr.gov',
  'federalregister.gov',
  'regulations.gov',
  'accessgudid.nlm.nih.gov',
  'ec.europa.eu',
];
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const webSourceKey = (url: string) => `W-${digest(url)}`;
const cacheLifetime = 24 * 60 * 60 * 1000;

export async function cachedPublicWebArchive(tx: PoolClient, projectId: string, url: string) {
  const result = await tx.query<{
    documentId: string;
    version: number;
    title: string;
    voided: boolean;
    archive: unknown;
    originalHash: string | null;
    text: string | null;
    placeholder: boolean | null;
  }>(
    `SELECT d.id AS "documentId",v.version_no AS version,d.name AS title,d.voided,
     v.source_metadata->'webArchive' AS archive,v.original_sha256 AS "originalHash",
     p.text,p.is_placeholder AS placeholder
     FROM document d JOIN document_version v ON v.document_id=d.id
     LEFT JOIN document_page p ON p.version_id=v.id AND p.page_number=1
     WHERE d.project_id=$1 AND d.source_key=$2 ORDER BY v.version_no DESC LIMIT 1`,
    [projectId, webSourceKey(url)],
  );
  const row = result.rows[0];
  if (row?.voided) throw new AppError(409, 'DOCUMENT_VOIDED', '该网页资料已作废，请由负责人处理。');
  const archive = webArchiveInfoSchema.safeParse(row?.archive);
  if (
    !row ||
    !archive.success ||
    archive.data.url !== url ||
    archive.data.sha256 !== row.originalHash
  )
    return null;
  const age = Date.now() - Date.parse(archive.data.fetchedAt);
  if (age > cacheLifetime || age < -5000) return null;
  return { ...row, archive: archive.data, placeholder: row.placeholder ?? true };
}

export function classifyWebSource(url: string, extendedHosts: readonly string[] = []) {
  const host = new URL(url).hostname;
  if (officialHosts.some((domain) => host === domain || host.endsWith(`.${domain}`)))
    return 'official';
  return extendedHosts.includes(host) ? 'extended' : 'general';
}

export async function downloadPublicWebSnapshot(
  fetcher: Pick<FetcherClient, 'fetchPage'>,
  url: string,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new AppError(409, 'WEB_STOPPED', '运行已停止，网页请求未发出。');
  const snapshot = await fetcher.fetchPage(url, signal);
  if (signal?.aborted) throw new AppError(409, 'WEB_STOPPED', '运行已停止，本次抓取结果未保存。');
  const bytes = Buffer.from(snapshot.bodyBase64, 'base64');
  if (
    snapshot.url !== url ||
    bytes.length > 2 * 1024 * 1024 ||
    bytes.toString('base64') !== snapshot.bodyBase64 ||
    digest(bytes) !== snapshot.sha256 ||
    Date.parse(snapshot.fetchedAt) > Date.now() + 5000
  )
    throw new AppError(502, 'WEB_SNAPSHOT_INVALID', '网页原件地址、内容哈希或抓取时间未能核对。');
  return { snapshot, bytes };
}

export async function archivePublicWebSnapshot(
  pool: Pool,
  store: DocumentBlobStore,
  tx: PoolClient,
  projectId: string,
  downloaded: Awaited<ReturnType<typeof downloadPublicWebSnapshot>>,
  sourceType: WebArchiveInfo['sourceType'],
) {
  const { bytes, snapshot } = downloaded;
  const archive = webArchiveInfoSchema.parse({
    url: snapshot.url,
    fetchedAt: snapshot.fetchedAt,
    mediaType: snapshot.mediaType,
    sha256: snapshot.sha256,
    sourceType,
    extractedTruncated: snapshot.truncated,
  });
  const original = await store.put(bytes);
  if (original.sha256 !== snapshot.sha256 || original.byteSize !== bytes.byteLength)
    throw new AppError(500, 'WEB_STORAGE_MISMATCH', '网页原件存储校验失败，未登记资料。');
  const sourceKey = webSourceKey(snapshot.url);
  const placeholder = !snapshot.text.trim();
  const saved = await ingestParsedDocument(
    pool,
    store,
    {
      projectId,
      sourceKey,
      name: snapshot.title,
      sourcePath: snapshot.url,
      sourceSnapshot: digest(JSON.stringify(archive)),
      originalSha256: snapshot.sha256,
      dataLevel: 'public',
      authorType: 'external',
      sourceMetadata: { webArchive: archive },
      pages: [
        {
          pageNumber: 1,
          text: snapshot.text,
          method: 'text',
          locatorKind: 'extraction_unit',
          isPlaceholder: placeholder,
        },
      ],
    },
    tx,
  );
  return { archive, sourceKey, saved, placeholder };
}
