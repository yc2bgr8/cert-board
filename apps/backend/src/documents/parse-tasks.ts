import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  documentOriginalInputSchema,
  type DocumentFormat,
  type DocumentPageSource,
  type ServiceIdentity,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { authorize } from '../auth/authorization.js';
import { getProject } from '../projects/service.js';
import type { DocumentBlobStore } from './blob-store.js';
import { maximumDocumentBytes, type DocumentParserClient } from './docsvc-client.js';
import { insertDocumentPages } from './service.js';

const formats: Record<DocumentFormat, string> = {
  pdf: 'application/pdf',
  estar: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export async function queueOriginalDocument(
  pool: Pool,
  store: DocumentBlobStore,
  actor: ServiceIdentity,
  input: unknown,
  bytes: Buffer,
) {
  const checked = documentOriginalInputSchema.safeParse(input);
  if (!checked.success || !Buffer.isBuffer(bytes) || !bytes.length)
    throw new AppError(
      400,
      'DOCUMENT_UPLOAD_INVALID',
      '原件或资料信息不完整，请选择一个支持的文件。',
    );
  if (bytes.length > maximumDocumentBytes)
    throw new AppError(413, 'DOCUMENT_UPLOAD_LIMIT', '原件超过 96 MiB，请拆分资料后导入。');
  const data = checked.data;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ ...data, sha256 }))
    .digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const project = await getProject(client, actor, data.projectId);
    if (
      !authorize(actor, 'document.write', {
        projectId: project.id,
        ownerUserId: project.ownerUserId,
      })
    )
      throw new AppError(403, 'DOCUMENT_UPLOAD_FORBIDDEN', '没有权限向该项目写入资料。');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${project.id}:${data.sourceKey}`,
    ]);
    const existing = (
      await client.query<{ id: string; voided: boolean }>(
        'SELECT id,voided FROM document WHERE project_id=$1 AND source_key=$2 FOR UPDATE',
        [project.id, data.sourceKey],
      )
    ).rows[0];
    if (existing?.voided)
      throw new AppError(409, 'DOCUMENT_VOIDED', '该资料已作废，请新建资料并保留旧版本。');
    const prior = existing
      ? (
          await client.query<{ id: string; version_no: number; fingerprint: string | null }>(
            `SELECT id,version_no,source_metadata->'_certImport'->>'fingerprint' AS fingerprint
       FROM document_version WHERE document_id=$1 AND source_snapshot=$2`,
            [existing.id, data.sourceSnapshot],
          )
        ).rows[0]
      : undefined;
    if (prior && prior.fingerprint !== fingerprint)
      throw new AppError(
        409,
        'DOCUMENT_SNAPSHOT_CONFLICT',
        '这一快照已有不同内容，请使用新的快照编号。',
      );
    const saved = await store.put(bytes);
    if (saved.sha256 !== sha256 || saved.byteSize !== bytes.length)
      throw new AppError(500, 'DOCUMENT_STORAGE_MISMATCH', '原件存储校验失败，本次登记未生效。');
    if (existing && prior) {
      await client.query('COMMIT');
      return {
        documentId: existing.id,
        versionId: prior.id,
        version: prior.version_no,
        created: false,
      };
    }
    const documentId =
      existing?.id ??
      (
        await client.query<{ id: string }>(
          'INSERT INTO document (project_id,source_key,name,source_path,owner_user_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [project.id, data.sourceKey, data.name, data.sourcePath, project.ownerUserId],
        )
      ).rows[0]!.id;
    const inserted = (
      await client.query<{ id: string; version_no: number }>(
        `INSERT INTO document_version (document_id,version_no,source_snapshot,original_sha256,content_sha256,
        byte_size,media_type,content_kind,data_level,author_type,imported_by,source_metadata)
       SELECT $1,COALESCE(max(version_no),0)+1,$2,$3,$3,$4,$5,'original',$6,$7,$8,$9
       FROM document_version WHERE document_id=$1 RETURNING id,version_no`,
        [
          documentId,
          data.sourceSnapshot,
          sha256,
          saved.byteSize,
          formats[data.format],
          data.dataLevel,
          data.authorType,
          actor.userId,
          { _certImport: { fingerprint, name: data.name, sourcePath: data.sourcePath } },
        ],
      )
    ).rows[0]!;
    await client.query('INSERT INTO document_parse_task (version_id,format) VALUES ($1,$2)', [
      inserted.id,
      data.format,
    ]);
    if (existing)
      await client.query(
        'UPDATE document SET name=$1,source_path=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$3',
        [data.name, data.sourcePath, documentId],
      );
    await client.query(
      `INSERT INTO audit_log (actor_kind,actor_user_id,action,target_type,target_id,after_hash)
       VALUES ($1,$2,'document.parse_queued','document_version',$3,$4)`,
      [actor.kind, actor.userId, inserted.id, sha256],
    );
    await client.query('COMMIT');
    return { documentId, versionId: inserted.id, version: inserted.version_no, created: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'DOCUMENT_UPLOAD_FAILED', '原件登记未完成，请检查本机存储并重试。');
  } finally {
    client.release();
  }
}

type Claim = { version_id: string; lease_token: string; format: DocumentFormat; sha256: string };

async function claimTask(pool: Pool) {
  await pool.query(
    `UPDATE document_parse_task SET state='failed',lease_token=NULL,lease_until=NULL,
     error_code='DOC_PARSER_INTERRUPTED',updated_at=clock_timestamp()
     WHERE state='running' AND lease_until<=clock_timestamp() AND attempts=3`,
  );
  const result = await pool.query<Claim>(
    `WITH candidate AS (
       SELECT version_id FROM document_parse_task
       WHERE attempts<3 AND ((state='queued' AND available_at<=clock_timestamp())
         OR (state='running' AND lease_until<=clock_timestamp()))
       ORDER BY available_at,version_id LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     UPDATE document_parse_task q SET state='running',attempts=q.attempts+1,
       lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '8 minutes',
       error_code=NULL,updated_at=clock_timestamp()
     FROM candidate c JOIN document_version v ON v.id=c.version_id
     WHERE q.version_id=c.version_id
     RETURNING q.version_id,q.lease_token,q.format,v.original_sha256 AS sha256`,
  );
  return result.rows[0];
}

async function finishTask(pool: Pool, task: Claim, pages: readonly DocumentPageSource[]) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const changed = await client.query(
      `UPDATE document_parse_task SET state='ready',lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
       WHERE version_id=$1 AND state='running' AND lease_token=$2 AND lease_until>clock_timestamp()`,
      [task.version_id, task.lease_token],
    );
    if (changed.rowCount) {
      await insertDocumentPages(client, task.version_id, pages);
      await client.query(
        `INSERT INTO audit_log (actor_kind,action,target_type,target_id,after_hash)
         VALUES ('system','document.parsed','document_version',$1,$2)`,
        [task.version_id, task.sha256],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function processDocumentParseTask(
  pool: Pool,
  store: DocumentBlobStore,
  parser: Pick<DocumentParserClient, 'parse'>,
  signal?: AbortSignal,
) {
  if (signal?.aborted) return false;
  const task = await claimTask(pool);
  if (!task) return false;
  try {
    const content = await store.get(task.sha256);
    const pages = await parser.parse(content, task.sha256, task.format, signal);
    await finishTask(pool, task, pages);
  } catch (error) {
    const code =
      error instanceof AppError && /^[A-Z][A-Z0-9_]{1,63}$/u.test(error.code)
        ? error.code
        : 'DOC_PARSE_FAILED';
    const retry =
      !(error instanceof AppError) || error.statusCode === 429 || error.statusCode >= 500;
    await pool.query(
      `UPDATE document_parse_task
       SET state=CASE WHEN $3 AND attempts<3 THEN 'queued' ELSE 'failed' END::document_parse_state,
         lease_token=NULL,lease_until=NULL,error_code=$4,
         available_at=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp()
       WHERE version_id=$1 AND state='running' AND lease_token=$2 AND lease_until>clock_timestamp()`,
      [task.version_id, task.lease_token, retry, code],
    );
  }
  return true;
}

export function startDocumentParseWorker(
  pool: Pool,
  store: DocumentBlobStore,
  parser: Pick<DocumentParserClient, 'parse'>,
  reportError: () => void,
) {
  const stop = new AbortController();
  let running: Promise<unknown> | undefined;
  const dispatch = () => {
    if (running || stop.signal.aborted) return;
    running = processDocumentParseTask(pool, store, parser, stop.signal)
      .catch(reportError)
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(dispatch, 1_000);
  dispatch();
  return async () => {
    clearInterval(timer);
    stop.abort();
    await running;
  };
}
