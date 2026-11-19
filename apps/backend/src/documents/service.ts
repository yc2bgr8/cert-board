import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  documentImportSchema,
  documentListOptionsSchema,
  documentListSchema,
  documentRecordSchema,
  documentVersionListOptionsSchema,
  documentVersionListSchema,
  documentVersionRecordSchema,
  documentPageParamsSchema,
  documentPageReadOptionsSchema,
  documentPageReadSchema,
  documentSearchOptionsSchema,
  documentSearchResultSchema,
  projectIdSchema,
  webArchiveInfoSchema,
  type ServiceIdentity,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { authorize } from '../auth/authorization.js';
import { getProject } from '../projects/service.js';
import type { DocumentBlobStore } from './blob-store.js';

export type DocumentReadDatabase = Pick<Pool, 'query'>;

const maximumImportBytes = 25 * 1024 * 1024;
const maximumInteger = 2_147_483_647;
const classification = `(SELECT sv.data_level FROM document_version sv WHERE sv.document_id = d.id ORDER BY sv.data_level DESC LIMIT 1)`;
const latestVersion = `JOIN LATERAL (SELECT lv.version_no FROM document_version lv WHERE lv.document_id = d.id ORDER BY lv.version_no DESC LIMIT 1) current ON true`;
const documentFields = `d.id, d.project_id AS "projectId", d.source_key AS "sourceKey", d.name,
  d.source_path AS "sourcePath", d.owner_user_id AS "ownerUserId", ${classification} AS "dataLevel",
  CASE WHEN d.voided THEN 'voided' ELSE 'active' END AS status,
  current.version_no AS "currentVersion", d.version, d.created_at AS "createdAt", d.updated_at AS "updatedAt"`;
const versionFields = `v.id, v.document_id AS "documentId", v.version_no AS version,
  v.source_snapshot AS "sourceSnapshot", v.content_sha256 AS "contentSha256",
  v.original_sha256 AS "originalSha256", v.byte_size AS "byteSize", v.content_kind AS "contentKind",
  v.media_type AS "mediaType", v.author_type AS "authorType", ${classification} AS "dataLevel",
  v.imported_by AS "importedBy", (SELECT count(*)::integer FROM document_page count_page WHERE count_page.version_id = v.id) AS "pageCount",
  v.created_at AS "createdAt"`;
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
const notFound = () =>
  new AppError(404, 'DOCUMENT_NOT_FOUND', '未找到可访问的有效资料，请重新选择资料或联系负责人。');
const invalid = () =>
  new AppError(
    400,
    'DOCUMENT_INPUT_INVALID',
    '资料输入或读取位置无效，请核对资料编号、版本、页码和分页参数。',
  );
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}
const canonicalJson = (value: unknown) => JSON.stringify(canonicalValue(value));
function toDocument(row: Record<string, unknown>) {
  return documentRecordSchema.parse({
    ...row,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}
function toVersion(row: Record<string, unknown>) {
  return documentVersionRecordSchema.parse({
    ...row,
    byteSize: Number(row.byteSize),
    createdAt: iso(row.createdAt),
  });
}
async function projectAccess(
  pool: DocumentReadDatabase,
  identity: ServiceIdentity,
  projectId: string,
) {
  if (!projectIdSchema.safeParse(projectId).success) throw invalid();
  await getProject(pool, identity, projectId);
}

export async function ingestParsedDocument(
  pool: Pool,
  store: DocumentBlobStore,
  input: unknown,
  transaction?: PoolClient,
) {
  const parsed = documentImportSchema.safeParse(input);
  if (!parsed.success)
    throw new AppError(
      400,
      'DOCUMENT_IMPORT_INVALID',
      '资料导入字段不完整或格式无效；必须指定数据级别、作者类型和唯一页码，原文不得包含空字符。',
    );
  const data = parsed.data;
  let textBytes = 0;
  for (const page of data.pages) {
    textBytes += Buffer.byteLength(page.text, 'utf8');
    if (page.pageNumber > maximumInteger || page.text.includes('\0')) throw invalid();
    if (textBytes > maximumImportBytes)
      throw new AppError(413, 'DOCUMENT_TOO_LARGE', '解析内容超过25MiB，请拆分资料后导入。');
  }
  const content = Buffer.from(
    canonicalJson({ format: 'cert-board-parsed-pages-v1', pages: data.pages }),
    'utf8',
  );
  if (content.byteLength > maximumImportBytes)
    throw new AppError(413, 'DOCUMENT_TOO_LARGE', '解析内容超过25MiB，请拆分资料后导入。');
  const contentSha256 = hash(content);
  const fingerprint = hash(
    canonicalJson({
      name: data.name,
      sourcePath: data.sourcePath,
      originalSha256: data.originalSha256,
      dataLevel: data.dataLevel,
      authorType: data.authorType,
      sourceMetadata: data.sourceMetadata,
      contentSha256,
    }),
  );
  const metadata = {
    ...data.sourceMetadata,
    _certImport: { fingerprint, name: data.name, sourcePath: data.sourcePath },
  };
  const client = transaction ?? (await pool.connect());
  try {
    if (!transaction) await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${data.projectId}:${data.sourceKey}`,
    ]);
    const project = await client.query<{ owner_user_id: string }>(
      'SELECT owner_user_id FROM cert_project WHERE id = $1 FOR SHARE',
      [data.projectId],
    );
    if (!project.rows[0])
      throw new AppError(404, 'PROJECT_NOT_FOUND', '导入项目不存在，请先建立项目。');
    const existing = await client.query<{ id: string; voided: boolean }>(
      'SELECT id, voided FROM document WHERE project_id = $1 AND source_key = $2 FOR UPDATE',
      [data.projectId, data.sourceKey],
    );
    let documentId = existing.rows[0]?.id;
    if (existing.rows[0]?.voided)
      throw new AppError(
        409,
        'DOCUMENT_VOIDED',
        '该资料已经作废，不能通过重复导入恢复，请联系负责人处理。',
      );
    const previous = documentId
      ? await client.query<{
          id: string;
          version_no: number;
          source_metadata: { _certImport?: { fingerprint?: string } };
        }>(
          'SELECT id, version_no, source_metadata FROM document_version WHERE document_id = $1 AND source_snapshot = $2',
          [documentId, data.sourceSnapshot],
        )
      : null;
    const previousVersion = previous?.rows[0];
    if (
      previousVersion &&
      previousVersion.source_metadata._certImport?.fingerprint !== fingerprint
    ) {
      throw new AppError(
        409,
        'DOCUMENT_SNAPSHOT_CONFLICT',
        '同一来源快照的内容或元数据发生变化，请提供新的快照编号，不能覆盖已有证据。',
      );
    }
    const stored = await store.put(content);
    if (stored.sha256 !== contentSha256 || stored.byteSize !== content.byteLength)
      throw new AppError(
        500,
        'DOCUMENT_STORAGE_MISMATCH',
        '文件存储返回的内容校验不一致，本次导入未登记。',
      );
    if (previousVersion && documentId) {
      if (!transaction) await client.query('COMMIT');
      return {
        documentId,
        versionId: previousVersion.id,
        version: previousVersion.version_no,
        created: false,
        contentSha256,
      };
    }
    const isNewDocument = !documentId;
    if (!documentId) {
      const inserted = await client.query<{ id: string }>(
        'INSERT INTO document (project_id, source_key, name, source_path, owner_user_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [data.projectId, data.sourceKey, data.name, data.sourcePath, project.rows[0].owner_user_id],
      );
      documentId = inserted.rows[0]?.id;
    }
    if (!documentId) throw new Error('资料登记失败');
    const latest = await client.query<{
      version_no: number;
      source_metadata: { _certImport?: { fingerprint?: string } };
    }>(
      'SELECT version_no, source_metadata FROM document_version WHERE document_id=$1 ORDER BY version_no DESC LIMIT 1',
      [documentId],
    );
    const version = (latest.rows[0]?.version_no ?? 0) + 1;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO document_version (document_id, version_no, source_snapshot, original_sha256, content_sha256,
       byte_size, media_type, content_kind, data_level, author_type, source_metadata)
       VALUES ($1,$2,$3,$4,$5,$6,'application/json','parsed_text',$7,$8,$9) RETURNING id`,
      [
        documentId,
        version,
        data.sourceSnapshot,
        data.originalSha256,
        contentSha256,
        stored.byteSize,
        data.dataLevel,
        data.authorType,
        metadata,
      ],
    );
    const versionId = inserted.rows[0]?.id;
    if (!versionId) throw new Error('资料版本登记失败');
    await client.query(
      `INSERT INTO document_page (version_id,page_number,text,method,locator_kind,ocr_score,is_placeholder)
       SELECT $1, p."pageNumber",p.text,p.method::document_page_method,p."locatorKind"::document_locator_kind,p."ocrScore",p."isPlaceholder"
       FROM jsonb_to_recordset($2::jsonb) AS p("pageNumber" integer,text text,method text,"locatorKind" text,"ocrScore" double precision,"isPlaceholder" boolean)`,
      [versionId, JSON.stringify(data.pages)],
    );
    if (!isNewDocument)
      await client.query(
        'UPDATE document SET name=$1, source_path=$2, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id=$3',
        [data.name, data.sourcePath, documentId],
      );
    await client.query(
      `INSERT INTO audit_log (actor_kind, action, target_type, target_id, before_hash, after_hash)
       VALUES ('system','document.imported','document_version',$1,$2,$3)`,
      [versionId, latest.rows[0]?.source_metadata._certImport?.fingerprint ?? null, fingerprint],
    );
    if (!transaction) await client.query('COMMIT');
    return { documentId, versionId, version, created: true, contentSha256 };
  } catch (error) {
    if (!transaction) await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError(
      500,
      'DOCUMENT_IMPORT_FAILED',
      '资料导入失败，本次数据库登记已撤销，请检查存储和迁移后重试。',
    );
  } finally {
    if (!transaction) client.release();
  }
}

export async function listDocuments(
  pool: DocumentReadDatabase,
  identity: ServiceIdentity,
  projectId: string,
  options: unknown = {},
) {
  await projectAccess(pool, identity, projectId);
  const parsed = documentListOptionsSchema.safeParse(options);
  if (!parsed.success) throw invalid();
  const page = parsed.data;
  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${documentFields} FROM document d ${latestVersion} WHERE d.project_id=$1 AND NOT d.voided
     AND ($2::uuid IS NULL OR d.id>$2::uuid) ORDER BY d.id LIMIT $3`,
    [projectId, page.cursor ?? null, page.limit + 1],
  );
  const hasMore = result.rows.length > page.limit;
  const items = result.rows.slice(0, page.limit).map(toDocument);
  return documentListSchema.parse({
    items,
    hasMore,
    nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
  });
}

export async function getDocument(
  pool: DocumentReadDatabase,
  identity: ServiceIdentity,
  documentId: string,
) {
  if (!projectIdSchema.safeParse(documentId).success) throw invalid();
  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${documentFields} FROM document d ${latestVersion} WHERE d.id=$1 AND NOT d.voided`,
    [documentId],
  );
  const row = result.rows[0];
  if (!row) throw notFound();
  try {
    await getProject(pool, identity, String(row.projectId));
  } catch (error) {
    if (error instanceof AppError && [403, 404].includes(error.statusCode)) throw notFound();
    throw error;
  }
  if (
    !authorize(identity, 'document.read', {
      projectId: row.projectId,
      ownerUserId: row.ownerUserId,
    })
  )
    throw notFound();
  return toDocument(row);
}

export async function listDocumentVersions(
  pool: DocumentReadDatabase,
  identity: ServiceIdentity,
  documentId: string,
  options: unknown = {},
) {
  await getDocument(pool, identity, documentId);
  const parsed = documentVersionListOptionsSchema.safeParse(options);
  if (!parsed.success || parsed.data.afterVersion > maximumInteger) throw invalid();
  const page = parsed.data;
  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${versionFields} FROM document_version v JOIN document d ON d.id=v.document_id
     WHERE d.id=$1 AND NOT d.voided AND v.version_no>$2 ORDER BY v.version_no LIMIT $3`,
    [documentId, page.afterVersion, page.limit + 1],
  );
  const hasMore = result.rows.length > page.limit;
  const items = result.rows.slice(0, page.limit).map(toVersion);
  return documentVersionListSchema.parse({
    items,
    hasMore,
    nextAfterVersion: hasMore ? (items.at(-1)?.version ?? null) : null,
  });
}

export async function readDocumentPage(
  pool: DocumentReadDatabase,
  identity: ServiceIdentity,
  documentId: string,
  version: number,
  pageNumber: number,
  options: unknown = {},
) {
  const location = documentPageParamsSchema.safeParse({
    id: documentId,
    version,
    page: pageNumber,
  });
  const parsed = documentPageReadOptionsSchema.safeParse(options);
  if (
    !location.success ||
    !parsed.success ||
    version > maximumInteger ||
    pageNumber > maximumInteger
  )
    throw invalid();
  await getDocument(pool, identity, documentId);
  const result = await pool.query<Record<string, unknown>>(
    `SELECT d.id AS "documentId",d.source_key AS "sourceKey",COALESCE(v.source_metadata->'_certImport'->>'name',d.name) AS name,
     v.version_no AS version,p.page_number AS page,p.locator_kind AS "locatorKind",${classification} AS "dataLevel",
     p.text,p.method,p.ocr_score AS "ocrScore",p.is_placeholder AS "isPlaceholder",
     v.content_sha256 AS "contentSha256",v.original_sha256 AS "originalSha256",
     v.source_metadata->'webArchive' AS "webArchive"
     FROM document_page p JOIN document_version v ON v.id=p.version_id JOIN document d ON d.id=v.document_id
     WHERE d.id=$1 AND v.version_no=$2 AND p.page_number=$3 AND NOT d.voided`,
    [documentId, version, pageNumber],
  );
  const row = result.rows[0];
  if (!row) throw notFound();
  if (row.isPlaceholder)
    throw new AppError(
      422,
      'DOCUMENT_PLACEHOLDER',
      '该页仅为PDF阅读器提示，不是资料正文。请读取同包附件，或等待重新解析表单。',
    );
  const text = String(row.text);
  const offset = parsed.data.offset;
  if (offset > text.length)
    throw new AppError(
      400,
      'DOCUMENT_OFFSET_INVALID',
      '读取位置超过该页末尾，请使用上次返回的nextOffset继续读取。',
    );
  if (
    offset < text.length &&
    text.charCodeAt(offset) >= 0xdc00 &&
    text.charCodeAt(offset) <= 0xdfff
  ) {
    throw new AppError(
      400,
      'DOCUMENT_OFFSET_INVALID',
      '读取位置落在完整字符中间，请使用上次返回的nextOffset继续读取。',
    );
  }
  let end = Math.min(offset + parsed.data.limit, text.length);
  if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff)
    end--;
  if (end === offset && offset < text.length) {
    throw new AppError(
      400,
      'DOCUMENT_READ_LIMIT_TOO_SMALL',
      '读取上限过小，无法容纳一个完整字符，请将limit设为至少2后重试。',
    );
  }
  const { webArchive: rawArchive, ...pageFields } = row;
  const archive = webArchiveInfoSchema.safeParse(rawArchive);
  const warning = [
    archive.success ? '当前提供网页存档提取文本。' : '当前提供解析文本，原始文件尚未导入。',
  ];
  if (row.locatorKind === 'extraction_unit')
    warning.push('此页为文本提取单元，不代表Word物理页码。');
  if (typeof row.ocrScore === 'number' && row.ocrScore < 0.9)
    warning.push('文字识别置信度较低，请核对原始资料。');
  return documentPageReadSchema.parse({
    ...pageFields,
    ...(archive.success ? { webArchive: archive.data } : {}),
    text: text.slice(offset, end),
    warning: warning.join(' '),
    offset,
    totalCharacters: text.length,
    truncated: end < text.length,
    nextOffset: end < text.length ? end : null,
  });
}

export async function readWebArchiveInfo(
  db: DocumentReadDatabase,
  identity: ServiceIdentity,
  documentId: string,
  version: number,
) {
  if (!Number.isSafeInteger(version) || version < 1 || version > maximumInteger) throw invalid();
  const document = await getDocument(db, identity, documentId);
  const result = await db.query<{ archive: unknown; original_sha256: string | null }>(
    `SELECT v.source_metadata->'webArchive' AS archive,v.original_sha256
     FROM document_version v JOIN document d ON d.id=v.document_id
     WHERE v.document_id=$1 AND v.version_no=$2 AND NOT d.voided`,
    [document.id, version],
  );
  const row = result.rows[0];
  const archive = webArchiveInfoSchema.safeParse(row?.archive);
  if (!archive.success || archive.data.sha256 !== row?.original_sha256) throw notFound();
  return archive.data;
}

export async function searchDocuments(
  pool: DocumentReadDatabase,
  identity: ServiceIdentity,
  projectId: string,
  options: unknown,
) {
  await projectAccess(pool, identity, projectId);
  const parsed = documentSearchOptionsSchema.safeParse(options);
  if (!parsed.success || parsed.data.offset > maximumInteger) throw invalid();
  const page = parsed.data;
  const result = await pool.query<Record<string, unknown>>(
    `SELECT d.id AS "documentId",d.source_key AS "sourceKey",d.name,v.version_no AS version,p.page_number AS page,
      p.locator_kind AS "locatorKind",${classification} AS "dataLevel",p.method,p.ocr_score AS "ocrScore",
      p.text AS "pageText"
     FROM document d ${latestVersion} JOIN document_version v ON v.document_id=d.id AND v.version_no=current.version_no
     JOIN document_page p ON p.version_id=v.id WHERE d.project_id=$1 AND NOT d.voided AND NOT p.is_placeholder
      AND (strpos(lower(p.text),lower($2))>0 OR strpos(lower(d.name),lower($2))>0 OR strpos(lower(d.source_key),lower($2))>0)
     ORDER BY d.id,p.page_number LIMIT $3 OFFSET $4`,
    [projectId, page.query, page.limit + 1, page.offset],
  );
  const hasMore = result.rows.length > page.limit;
  // 当前镜像的中文长文本SQL摘要出现UTF8错误；改由程序截取，SQL仍先授权、筛选并限条数。
  const items = result.rows.slice(0, page.limit).map(({ pageText, ...row }) => {
    const text = String(pageText);
    let start = Math.max(0, text.toLowerCase().indexOf(page.query.toLowerCase()) - 80);
    if (start > 0 && text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff) start++;
    let end = Math.min(text.length, start + 300);
    if (
      end < text.length &&
      text.charCodeAt(end - 1) >= 0xd800 &&
      text.charCodeAt(end - 1) <= 0xdbff
    )
      end--;
    return { ...row, snippetOffset: start, snippet: text.slice(start, end) };
  });
  return documentSearchResultSchema.parse({
    items,
    hasMore,
    nextOffset: hasMore ? page.offset + page.limit : null,
  });
}
