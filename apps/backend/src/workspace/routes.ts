import type {
  FastifyInstance,
  FastifyBaseLogger,
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
} from 'fastify';
import type { Pool } from 'pg';
import {
  projectParamsSchema,
  workspaceParamsSchema,
  workspaceFilePathParamsSchema,
  workspaceFileQuerySchema,
  workspaceReadQuerySchema,
  workspaceDiffQuerySchema,
  workspaceDiffResponseSchema,
  humanRevisionQuerySchema,
  humanRevisionMaxBytes,
  type BackendConfig,
  type BrowserIdentity,
  type WorkspaceFileRecord,
} from '@cert-board/shared';
import { requireBrowserIdentity } from '../auth/session.js';
import { AppError } from '../api/errors.js';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import {
  getWorkspaceByProject,
  listVersions,
  listVersionFiles,
  listHumanRevisions,
  saveHumanRevision,
  readVersionFile,
} from './service.js';
import { compareFileManifests, compareTextLines } from './diff.js';
import { decodeUtf8Text } from './text.js';

const bad = () =>
  new AppError(400, 'WORKSPACE_QUERY_INVALID', '工作区读取参数无效，请重新选择版本或续读位置。');
function identifier(params: unknown) {
  const result = workspaceParamsSchema.safeParse(params);
  if (!result.success) throw bad();
  return result.data.id;
}
function requireStore(store: DocumentBlobStore | undefined) {
  if (!store)
    throw new AppError(
      503,
      'WORKSPACE_STORAGE_UNAVAILABLE',
      '文件存储未连接，请检查本地依赖服务。',
    );
  return store;
}
async function versionFor(
  pool: Pool,
  identity: BrowserIdentity,
  workspaceId: string,
  versionId?: string,
) {
  if (versionId) {
    await listVersionFiles(pool, identity, versionId, { limit: 1 });
    const found = await pool.query(
      'SELECT id FROM workspace_version WHERE id=$1 AND workspace_id=$2',
      [versionId, workspaceId],
    );
    if (found.rowCount !== 1)
      throw new AppError(404, 'WORKSPACE_VERSION_NOT_FOUND', '没有找到可访问的工作区版本。');
    return versionId;
  }
  const found = await pool.query<{ project_id: string }>(
    'SELECT project_id FROM workspace WHERE id=$1',
    [workspaceId],
  );
  if (!found.rows[0]) throw new AppError(404, 'WORKSPACE_NOT_FOUND', '没有找到可访问的工作区。');
  return (await getWorkspaceByProject(pool, identity, found.rows[0].project_id)).currentVersionId;
}
async function files(pool: Pool, identity: BrowserIdentity, versionId: string) {
  const all: WorkspaceFileRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await listVersionFiles(pool, identity, versionId, {
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    all.push(...page.items);
    if (all.length > 10000)
      throw new AppError(413, 'WORKSPACE_FILE_LIMIT', '文件超过对比上限，请分批核对。');
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return all;
}

export function registerWorkspaceRoutes<Logger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    Logger
  >,
  pool: Pool,
  config: BackendConfig,
  store?: DocumentBlobStore,
) {
  app.get('/api/projects/:id/workspace', async (request, reply) => {
    const identity = await requireBrowserIdentity(request, pool, config);
    reply.header('cache-control', 'no-store');
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) throw bad();
    return getWorkspaceByProject(pool, identity, params.data.id);
  });
  app.get('/api/workspaces/:id/versions', async (request, reply) => {
    const identity = await requireBrowserIdentity(request, pool, config);
    reply.header('cache-control', 'no-store');
    return listVersions(pool, identity, identifier(request.params), request.query);
  });
  app.get('/api/workspaces/:id/human-revisions', async (request, reply) => {
    const identity = await requireBrowserIdentity(request, pool, config);
    const query = humanRevisionQuerySchema.safeParse(request.query);
    if (!query.success) throw bad();
    reply.header('cache-control', 'no-store');
    return listHumanRevisions(
      pool,
      identity,
      identifier(request.params),
      query.data.reviewId,
      query.data.cursor,
    );
  });
  app.post(
    '/api/workspaces/:id/human-revisions',
    { bodyLimit: humanRevisionMaxBytes * 6 + 2048 },
    async (request, reply) => {
      const storage = requireStore(store);
      const workspaceId = identifier(request.params);
      const tx = await pool.connect();
      try {
        await tx.query('BEGIN');
        const actor = await requireBrowserIdentity(request, tx, config, { write: true });
        const locked = await tx.query(
          `SELECT s.id FROM web_session s JOIN app_user u ON u.id=s.user_id
        WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL
          AND s.expires_at>clock_timestamp() AND u.status='active' FOR SHARE OF s,u`,
          [actor.sessionId, actor.userId],
        );
        if (!locked.rowCount) throw new AppError(401, 'LOGIN_REQUIRED', '登录已失效，请重新登录。');
        const verified = await requireBrowserIdentity(request, tx, config, { write: true });
        const revision = await saveHumanRevision(tx, storage, verified, workspaceId, request.body);
        await tx.query('COMMIT');
        return reply.header('cache-control', 'no-store').send(revision);
      } catch (err) {
        await tx.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        tx.release();
      }
    },
  );
  app.get('/api/workspaces/:id/files', async (request, reply) => {
    const identity = await requireBrowserIdentity(request, pool, config);
    reply.header('cache-control', 'no-store');
    const query = workspaceFileQuerySchema.safeParse(request.query);
    if (!query.success) throw bad();
    const version = await versionFor(
      pool,
      identity,
      identifier(request.params),
      query.data.versionId,
    );
    return listVersionFiles(pool, identity, version, {
      limit: query.data.limit,
      ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
    });
  });
  app.get('/api/workspaces/:id/files/*', async (request, reply) => {
    const identity = await requireBrowserIdentity(request, pool, config);
    reply.header('cache-control', 'no-store');
    const params = workspaceFilePathParamsSchema.safeParse(request.params),
      query = workspaceReadQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) throw bad();
    const version = await versionFor(pool, identity, params.data.id, query.data.versionId);
    return readVersionFile(pool, requireStore(store), identity, version, params.data['*'], {
      offset: query.data.offset,
      limit: query.data.limit,
    });
  });
  app.get('/api/workspaces/:id/diff', async (request, reply) => {
    const identity = await requireBrowserIdentity(request, pool, config);
    reply.header('cache-control', 'no-store');
    const workspaceId = identifier(request.params),
      query = workspaceDiffQuerySchema.safeParse(request.query);
    if (!query.success) throw bad();
    const data = query.data;
    await versionFor(pool, identity, workspaceId, data.from);
    await versionFor(pool, identity, workspaceId, data.to);
    const [before, after] = await Promise.all([
      files(pool, identity, data.from),
      files(pool, identity, data.to),
    ]);
    if (!data.path) {
      const changes = compareFileManifests(before, after).filter(
          (change) => !data.cursor || change.path > data.cursor,
        ),
        page = changes.slice(0, data.limit),
        hasMore = changes.length > data.limit;
      return workspaceDiffResponseSchema.parse({
        kind: 'files',
        changes: page,
        hasMore,
        nextCursor: hasMore ? page.at(-1)!.path : null,
      });
    }
    const previous = before.find((file) => file.path === data.path) ?? null,
      next = after.find((file) => file.path === data.path) ?? null;
    if (!previous && !next)
      throw new AppError(404, 'WORKSPACE_FILE_NOT_FOUND', '两个版本中都没有该文件，请检查路径。');
    const base = {
      path: data.path,
      beforeSha256: previous?.sha256 ?? null,
      afterSha256: next?.sha256 ?? null,
    };
    if (
      [previous, next].some(
        (file) => file && (file.byteSize > 4 * 1024 * 1024 || !file.mediaType.startsWith('text/')),
      )
    )
      return workspaceDiffResponseSchema.parse({
        kind: 'binary',
        ...base,
        warning: '当前仅显示大文件或非文本文件的哈希变化；Word解析对比将在后续接入。',
      });
    const blobs = requireStore(store);
    let oldText: string, newText: string;
    try {
      [oldText, newText] = await Promise.all([
        previous ? blobs.get(previous.sha256).then(decodeUtf8Text) : '',
        next ? blobs.get(next.sha256).then(decodeUtf8Text) : '',
      ]);
    } catch (error) {
      if (error instanceof AppError && error.code === 'WORKSPACE_BINARY_FILE')
        return workspaceDiffResponseSchema.parse({
          kind: 'binary',
          ...base,
          warning: '文件不是可读取的UTF-8文本，当前仅显示哈希变化。',
        });
      throw error;
    }
    return workspaceDiffResponseSchema.parse({
      kind: 'text',
      ...base,
      diff: compareTextLines(oldText, newText, { offset: data.offset, limit: data.limit }),
    });
  });
}
