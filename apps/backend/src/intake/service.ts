import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  intakeReportSchema,
  intakeHistorySchema,
  intakeCategoryEditSchema,
  intakeStartSchema,
  intakeStartResultSchema,
  type IntakeCategory,
  type DocumentFormat,
  type ServiceIdentity,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { authorize } from '../auth/authorization.js';
import { getProject } from '../projects/service.js';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import type { DocumentParserClient } from '../documents/docsvc-client.js';
import { queueOriginalDocument } from '../documents/parse-tasks.js';
import {
  expandIntakeArchive,
  intakeFormat,
  intakePath,
  maximumExpandedBytes,
  maximumIntakeBytes,
  maximumIntakeItems,
  type ArchiveFile,
} from './archive.js';
import { classifyIntakePath } from './classify.js';

type Job = {
  id: string;
  project_id: string;
  requested_by: string;
  sha256: string;
  name: string;
  data_level: 'internal' | 'confidential' | 'public';
  state: 'queued' | 'running' | 'expanded' | 'failed';
  error_code: string | null;
  lease_token: string;
};
type IntakeFile = ArchiveFile & {
  parentPath: string | null;
  sourceNames: string[];
  format: DocumentFormat | undefined;
  errorCode: string | null;
};
type IntakeParser = Pick<DocumentParserClient, 'inspectPdf' | 'estarAttachments'>;
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const safeErrorCode = (error: unknown) =>
  error instanceof AppError && /^[A-Z][A-Z0-9_]{1,63}$/u.test(error.code)
    ? error.code
    : 'INTAKE_FAILED';
const retryableIntakeCodes = [
  'INTAKE_INTERRUPTED',
  'INTAKE_FAILED',
  'DOCSVC_UNAVAILABLE',
  'DOC_BUSY',
  'DOC_PROCESSING_TIMEOUT',
  'DOC_RESPONSE_INVALID',
  'BLOB_READ_FAILED',
  'BLOB_STORAGE_UNAVAILABLE',
];

async function renew(pool: Pool, job: Job) {
  const updated = await pool.query(
    `UPDATE intake_job SET lease_until=clock_timestamp()+interval '15 minutes'
     WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>clock_timestamp()`,
    [job.id, job.lease_token],
  );
  if (!updated.rowCount) throw new AppError(409, 'INTAKE_LEASE_LOST', '导入任务的执行权已变更。');
}

export async function requestIntake(
  pool: Pool,
  store: DocumentBlobStore,
  actor: ServiceIdentity,
  input: unknown,
  bytes: Buffer,
) {
  const request = intakeStartSchema.safeParse(input);
  if (
    !request.success ||
    !Buffer.isBuffer(bytes) ||
    !bytes.length ||
    !/\.zip$/iu.test(request.data.name)
  )
    throw new AppError(400, 'INTAKE_INPUT_INVALID', '请选择 ZIP 压缩包并指定项目。');
  if (bytes.length > maximumIntakeBytes)
    throw new AppError(413, 'INTAKE_UPLOAD_LIMIT', '压缩包超过 192 MiB，请分包导入。');
  const data = request.data;
  const project = await getProject(pool, actor, data.projectId);
  if (
    !authorize(actor, 'document.write', { projectId: project.id, ownerUserId: project.ownerUserId })
  )
    throw new AppError(403, 'INTAKE_FORBIDDEN', '没有权限为该项目导入资料。');
  const sha256 = hash(bytes);
  const stored = await store.put(bytes);
  if (stored.sha256 !== sha256 || stored.byteSize !== bytes.length)
    throw new AppError(500, 'INTAKE_STORE_INTEGRITY', '压缩包保存校验失败，未创建导入任务。');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = (
      await client.query<{ id: string }>(
        `INSERT INTO intake_job (project_id,requested_by,name,sha256,byte_size,data_level)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (project_id,sha256,data_level) DO NOTHING RETURNING id`,
        [project.id, actor.userId, data.name, sha256, bytes.length, data.dataLevel],
      )
    ).rows[0];
    if (created) {
      await client.query(
        `INSERT INTO audit_log(actor_kind,actor_user_id,action,target_type,target_id,after_hash)
         VALUES ($1,$2,'intake.queued','intake_job',$3,$4)`,
        [actor.kind, actor.userId, created.id, sha256],
      );
      await client.query('COMMIT');
      return intakeStartResultSchema.parse({ id: created.id, status: 'queued', created: true });
    }
    const prior = (
      await client.query<{ id: string }>(
        'SELECT id FROM intake_job WHERE project_id=$1 AND sha256=$2 AND data_level=$3',
        [project.id, sha256, data.dataLevel],
      )
    ).rows[0]!;
    const status = (await readIntakeReport(client, actor, prior.id)).status;
    await client.query('COMMIT');
    return intakeStartResultSchema.parse({ id: prior.id, status, created: false });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'INTAKE_QUEUE_FAILED', '导入任务登记未完成，请检查服务后重试。');
  } finally {
    client.release();
  }
}

async function claim(pool: Pool) {
  await pool.query(
    `UPDATE intake_job SET state='failed',lease_token=NULL,lease_until=NULL,
     error_code='INTAKE_INTERRUPTED',updated_at=clock_timestamp()
     WHERE state='running' AND attempts=3 AND lease_until<=clock_timestamp()`,
  );
  return (
    await pool.query<Job>(
      `WITH candidate AS (
       SELECT id FROM intake_job WHERE attempts<3 AND ((state='queued' AND available_at<=clock_timestamp())
         OR (state='running' AND lease_until<=clock_timestamp()))
       ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     UPDATE intake_job j SET state='running',attempts=j.attempts+1,lease_token=gen_random_uuid(),
       lease_until=clock_timestamp()+interval '15 minutes',error_code=NULL,updated_at=clock_timestamp()
     FROM candidate c WHERE j.id=c.id RETURNING j.*`,
    )
  ).rows[0];
}

async function expandedFiles(
  pool: Pool,
  job: Job,
  store: DocumentBlobStore,
  parser: IntakeParser,
  signal?: AbortSignal,
) {
  const blob = await store.get(job.sha256);
  if (hash(blob) !== job.sha256)
    throw new AppError(422, 'INTAKE_STORE_INTEGRITY', '原压缩包无法通过哈希校验。');
  const archive = await expandIntakeArchive(blob, signal);
  let expandedBytes = archive.expandedBytes;
  const files: IntakeFile[] = archive.files.map((file) => ({
    ...file,
    parentPath: null,
    sourceNames: [],
    format: intakeFormat(file.path),
    errorCode: null,
  }));
  const paths = new Set(files.map((file) => file.path));
  const evaluated = new Map<
    string,
    {
      format: 'pdf' | 'estar';
      errorCode: string | null;
      attachments: Awaited<ReturnType<IntakeParser['estarAttachments']>>;
    }
  >();
  for (const file of files) {
    signal?.throwIfAborted();
    if (file.format !== 'pdf' || !file.bytes.length) continue;
    const digest = hash(file.bytes);
    let result = evaluated.get(digest);
    if (!result) {
      result = { format: 'pdf', errorCode: null, attachments: [] };
      await renew(pool, job);
      try {
        result.format = await parser.inspectPdf(file.bytes, digest, signal);
        if (result.format === 'estar' && file.parentPath === null)
          result.attachments = await parser.estarAttachments(file.bytes, digest, signal);
      } catch (error) {
        if (!(error instanceof AppError) || error.statusCode === 429 || error.statusCode >= 500)
          throw error;
        result.errorCode = safeErrorCode(error);
      }
      evaluated.set(digest, result);
    }
    file.format = result.format;
    file.errorCode = result.errorCode;
    if (file.parentPath !== null) continue;
    for (const attachment of result.attachments) {
      expandedBytes += attachment.bytes.length;
      if (expandedBytes > maximumExpandedBytes || files.length >= maximumIntakeItems)
        throw new AppError(413, 'INTAKE_ARCHIVE_LIMIT', 'eSTAR 附件使资料包超过展开上限。');
      let relative = intakePath(`${file.path}!/${attachment.name}`);
      if (paths.has(relative))
        relative = intakePath(`${file.path}!/${attachment.sha256.slice(0, 12)}-${attachment.name}`);
      if (paths.has(relative))
        throw new AppError(422, 'INTAKE_PATH_DUPLICATE', 'eSTAR 中存在无法区分的附件路径。');
      paths.add(relative);
      files.push({
        path: relative,
        bytes: attachment.bytes,
        parentPath: file.path,
        sourceNames: attachment.sourceNames,
        format: intakeFormat(relative),
        errorCode: null,
      });
    }
  }
  return files;
}

async function registerFiles(
  pool: Pool,
  store: DocumentBlobStore,
  job: Job,
  files: IntakeFile[],
  signal?: AbortSignal,
) {
  const seen = new Map<string, { versionId: string | null; errorCode: string | null }>();
  const entries = files.map((file) => ({
    file,
    digest: hash(file.bytes),
    format: file.format,
  }));
  const supported = new Map<string, (typeof entries)[number]>();
  for (const entry of entries) {
    if (entry.format && entry.file.bytes.length && !supported.has(entry.digest))
      supported.set(entry.digest, entry);
  }
  for (const { file, digest } of entries) {
    signal?.throwIfAborted();
    await renew(pool, job);
    const representative = supported.get(digest);
    const format = representative?.format;
    const previous = seen.get(digest);
    let result = previous ?? { versionId: null, errorCode: 'INTAKE_FORMAT_UNSUPPORTED' };
    if (!previous && format && representative) {
      const stored = await queueOriginalDocument(
        pool,
        store,
        {
          kind: 'intake',
          userId: job.requested_by,
          jobId: job.id,
          leaseToken: job.lease_token,
        },
        {
          projectId: job.project_id,
          sourceKey: `intake-${digest}`,
          name: representative.file.path.split('/').at(-1)!.slice(0, 255),
          sourcePath: representative.file.path,
          format,
          sourceSnapshot: hash(`intake-v1:${job.sha256}:${digest}:${job.data_level}:${format}`),
          authorType: 'human',
          dataLevel: job.data_level,
        },
        representative.file.bytes,
      );
      result = { versionId: stored.versionId, errorCode: null };
    }
    seen.set(digest, result);
    const classification = classifyIntakePath(file.path);
    const recorded = await pool.query(
      `INSERT INTO intake_item (job_id,relative_path,parent_path,sha256,byte_size,duplicate,category,confidence,version_id,error_code,source_names)
       SELECT j.id,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb FROM intake_job j WHERE j.id=$1 AND j.lease_token=$2
         AND j.state='running' AND j.lease_until>clock_timestamp() ON CONFLICT (job_id,relative_path) DO NOTHING`,
      [
        job.id,
        job.lease_token,
        file.path,
        file.parentPath,
        digest,
        file.bytes.length,
        Boolean(previous),
        classification.category,
        classification.confidence,
        result.versionId,
        file.errorCode ?? result.errorCode,
        JSON.stringify(file.sourceNames),
      ],
    );
    if (!recorded.rowCount) {
      const owned = await pool.query(
        "SELECT 1 FROM intake_job WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>clock_timestamp()",
        [job.id, job.lease_token],
      );
      if (!owned.rowCount) throw new AppError(409, 'INTAKE_LEASE_LOST', '导入任务的执行权已变更。');
    }
  }
}

export async function processIntakeJob(
  pool: Pool,
  packages: DocumentBlobStore,
  originals: DocumentBlobStore,
  parser: IntakeParser,
  signal?: AbortSignal,
) {
  if (signal?.aborted) return false;
  const job = await claim(pool);
  if (!job) return false;
  try {
    const files = await expandedFiles(pool, job, packages, parser, signal);
    await registerFiles(pool, originals, job, files, signal);
    await pool.query(
      `UPDATE intake_job SET state='expanded',lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
       WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()`,
      [job.id, job.lease_token],
    );
  } catch (error) {
    const aborted = Boolean(signal?.aborted);
    const retry =
      aborted ||
      !(error instanceof AppError) ||
      error.statusCode === 429 ||
      error.statusCode >= 500;
    const reason = aborted
      ? null
      : error instanceof AppError && /^[A-Z][A-Z0-9_]{1,63}$/u.test(error.code)
        ? error.code
        : 'INTAKE_FAILED';
    await pool.query(
      `UPDATE intake_job SET state=CASE WHEN $5 OR ($3 AND attempts<3) THEN 'queued' ELSE 'failed' END::intake_job_state,
         attempts=attempts-CASE WHEN $5 THEN 1 ELSE 0 END, lease_token=NULL,lease_until=NULL,error_code=$4,
         available_at=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp()
       WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()`,
      [job.id, job.lease_token, retry, reason, aborted],
    );
  }
  return true;
}

export function startIntakeWorker(
  pool: Pool,
  packages: DocumentBlobStore,
  originals: DocumentBlobStore,
  parser: IntakeParser,
  reportError: () => void,
) {
  const shutdown = new AbortController();
  let active: Promise<unknown> | undefined;
  const tick = () => {
    if (active || shutdown.signal.aborted) return;
    active = processIntakeJob(pool, packages, originals, parser, shutdown.signal)
      .catch(reportError)
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(tick, 1_000);
  tick();
  return async () => {
    clearInterval(timer);
    shutdown.abort();
    await active;
  };
}

export async function readIntakeReport(
  pool: Pick<Pool, 'query'>,
  actor: ServiceIdentity,
  id: string,
) {
  const job = (await pool.query<Job>('SELECT * FROM intake_job WHERE id=$1', [id])).rows[0];
  if (!job) throw new AppError(404, 'INTAKE_NOT_FOUND', '未找到该导入任务，请从项目资料入口打开。');
  await getProject(pool, actor, job.project_id);
  const items = (
    await pool.query(
      `SELECT i.relative_path AS path,i.parent_path AS "parentPath",i.parent_path IS NOT NULL AS embedded,
       i.source_names AS "sourceNames",
       i.sha256,i.byte_size AS "byteSize",i.duplicate,i.category,i.confidence,
       v.document_id AS "documentId",v.version_no AS version,t.state AS "parseStatus",
       COALESCE(i.error_code,t.error_code) AS "errorCode"
     FROM intake_item i LEFT JOIN document_version v ON v.id=i.version_id
     LEFT JOIN document_parse_task t ON t.version_id=v.id WHERE i.job_id=$1 ORDER BY i.relative_path`,
      [id],
    )
  ).rows;
  const categories = new Map<IntakeCategory, number>();
  const totals = {
    outerFiles: 0,
    embeddedFiles: 0,
    uniqueFiles: 0,
    duplicates: 0,
    queued: 0,
    ready: 0,
    failed: 0,
    reviewNeeded: 0,
  };
  for (const item of items) {
    if (item.embedded) totals.embeddedFiles++;
    else totals.outerFiles++;
    if (item.duplicate) totals.duplicates++;
    else totals.uniqueFiles++;
    if (item.parseStatus === 'queued' || item.parseStatus === 'running') totals.queued++;
    else if (item.errorCode || item.parseStatus === 'failed') totals.failed++;
    else if (item.parseStatus === 'ready') totals.ready++;
    if (item.category === 'review_needed') totals.reviewNeeded++;
    categories.set(item.category, (categories.get(item.category) ?? 0) + 1);
  }
  const status = job.state === 'expanded' ? (totals.queued ? 'parsing' : 'complete') : job.state;
  return intakeReportSchema.parse({
    id,
    projectId: job.project_id,
    name: job.name,
    status,
    dataLevel: job.data_level,
    errorCode: job.error_code,
    canRetry:
      job.state === 'failed' &&
      job.error_code !== null &&
      retryableIntakeCodes.includes(job.error_code),
    totals,
    categories: [...categories].map(([category, count]) => ({ category, count })),
    items,
  });
}

export async function listIntakes(
  pool: Pool,
  actor: ServiceIdentity,
  projectId: string,
  cursor?: string,
) {
  await getProject(pool, actor, projectId);
  const result = await pool.query<{ id: string; name: string }>(
    `SELECT j.id,j.name FROM intake_job j WHERE j.project_id=$1
     AND ($2::uuid IS NULL OR (j.created_at,j.id)<(
       SELECT marker.created_at,marker.id FROM intake_job marker WHERE marker.id=$2 AND marker.project_id=$1
     )) ORDER BY j.created_at DESC,j.id DESC LIMIT 51`,
    [projectId, cursor ?? null],
  );
  const items = result.rows.slice(0, 50);
  return intakeHistorySchema.parse({
    items,
    nextCursor: result.rows.length > 50 ? items.at(-1)!.id : null,
  });
}

export async function retryIntake(pool: Pool, actor: ServiceIdentity, id: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const job = (await client.query<Job>('SELECT * FROM intake_job WHERE id=$1 FOR UPDATE', [id]))
      .rows[0];
    if (!job) throw new AppError(404, 'INTAKE_NOT_FOUND', '未找到该导入任务。');
    const project = await getProject(client, actor, job.project_id);
    if (
      !authorize(actor, 'document.write', {
        projectId: project.id,
        ownerUserId: project.ownerUserId,
      })
    )
      throw new AppError(403, 'INTAKE_FORBIDDEN', '没有权限重新提交该任务。');
    if (job.state !== 'failed' || !job.error_code || !retryableIntakeCodes.includes(job.error_code))
      throw new AppError(
        409,
        'INTAKE_RETRY_UNAVAILABLE',
        '该导入任务当前无法重试，请核对报告状态。',
      );
    await client.query(
      `UPDATE intake_job SET state='queued',attempts=0,error_code=NULL,
      available_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,
      [id],
    );
    await client.query(
      `INSERT INTO audit_log(actor_kind,actor_user_id,action,target_type,target_id,after_hash)
       VALUES ($1,$2,'intake.retried','intake_job',$3,$4)`,
      [actor.kind, actor.userId, id, job.sha256],
    );
    await client.query('COMMIT');
    return intakeStartResultSchema.parse({ id, status: 'queued', created: false });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function editIntakeCategory(
  pool: Pool,
  actor: ServiceIdentity,
  id: string,
  input: unknown,
) {
  const checked = intakeCategoryEditSchema.safeParse(input);
  if (!checked.success)
    throw new AppError(400, 'INTAKE_CATEGORY_INVALID', '请选择有效的资料分类。');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const item = (
      await client.query<{ id: string; project_id: string; category: string }>(
        `SELECT i.id,j.project_id,i.category FROM intake_item i JOIN intake_job j ON j.id=i.job_id
       WHERE j.id=$1 AND i.relative_path=$2 FOR UPDATE OF i`,
        [id, intakePath(checked.data.path)],
      )
    ).rows[0];
    if (!item) throw new AppError(404, 'INTAKE_ITEM_MISSING', '未找到该导入明细，请重新打开报告。');
    const project = await getProject(client, actor, item.project_id);
    if (
      !authorize(actor, 'document.write', {
        projectId: project.id,
        ownerUserId: project.ownerUserId,
      })
    )
      throw new AppError(403, 'INTAKE_FORBIDDEN', '没有权限修改该资料分类。');
    if (checked.data.category !== item.category) {
      await client.query(
        'UPDATE intake_item SET category=$1,confidence=NULL,updated_at=clock_timestamp() WHERE id=$2',
        [checked.data.category, item.id],
      );
      await client.query(
        `INSERT INTO audit_log(actor_kind,actor_user_id,action,target_type,target_id,before_hash,after_hash)
         VALUES ($1,$2,'intake.category_changed','intake_item',$3,$4,$5)`,
        [actor.kind, actor.userId, item.id, hash(item.category), hash(checked.data.category)],
      );
    }
    const report = await readIntakeReport(client, actor, id);
    await client.query('COMMIT');
    return report;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'INTAKE_CATEGORY_FAILED', '分类未能保存，请刷新导入报告后重试。');
  } finally {
    client.release();
  }
}
