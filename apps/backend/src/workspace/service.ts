import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  browserIdentitySchema,
  projectIdSchema,
  workspacePathSchema,
  workspaceRecordSchema,
  workspaceVersionRecordSchema,
  workspaceDraftRecordSchema,
  workspaceFileRecordSchema,
  workspaceReadFileSchema,
  workspaceWriteFileSchema,
  workspaceSaveSchema,
  workspaceRestoreSchema,
  workspaceVersionListOptionsSchema,
  workspaceVersionListSchema,
  workspaceFileListOptionsSchema,
  workspaceFileListSchema,
  workspaceWriteResultSchema,
  workspaceSaveResultSchema,
  workspaceRebaseSchema,
  workspaceRebaseResultSchema,
  type BrowserIdentity,
  type DataLevel,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { authorize } from '../auth/authorization.js';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import { compareFileManifests } from './diff.js';
import { decodeUtf8Text, sliceUnicodeText } from './text.js';

type Executor = Pool | PoolClient;
type Workspace = ReturnType<typeof workspaceRecordSchema.parse>;
type Draft = ReturnType<typeof workspaceDraftRecordSchema.parse>;
type FileRecord = ReturnType<typeof workspaceFileRecordSchema.parse>;
type Manifest = Map<string, FileRecord>;
type Conversation = {
  id: string;
  project_id: string | null;
  user_id: string;
  mode: string;
  status: string;
  max_data_level: DataLevel;
};
type DraftContext = { workspace: Workspace; draft: Draft; conversation: Conversation };
const maxFiles = 10_000;
const decisionPath = '决定记录.md';
const workspaceFields = `w.id,w.project_id AS "projectId",w.current_version_id AS "currentVersionId",w.data_level AS "dataLevel",w.version,w.created_at AS "createdAt",w.updated_at AS "updatedAt"`;
const versionFields = `v.id,v.workspace_id AS "workspaceId",v.project_id AS "projectId",v.number,v.parent_version_id AS "parentVersionId",v.author_user_id AS "authorUserId",v.author_type AS "authorType",v.summary,v.data_level AS "dataLevel",v.created_at AS "createdAt"`;
const draftFields = `d.id,d.workspace_id AS "workspaceId",d.project_id AS "projectId",d.conversation_id AS "conversationId",d.owner_user_id AS "ownerUserId",d.base_version_id AS "baseVersionId",d.data_level AS "dataLevel",d.version,d.created_at AS "createdAt",d.updated_at AS "updatedAt"`;
const fileFields = `path,sha256,byte_size AS "byteSize",data_level AS "dataLevel",media_type AS "mediaType"`;
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
const invalid = () =>
  new AppError(
    400,
    'WORKSPACE_INPUT_INVALID',
    '工作区参数无效，请使用返回的编号、文件路径和续读位置重试。',
  );
const absent = () =>
  new AppError(
    404,
    'WORKSPACE_NOT_FOUND',
    '未找到可访问的工作区或工作副本，请从当前项目重新打开。',
  );
function actor(identity: BrowserIdentity) {
  const parsed = browserIdentitySchema.safeParse(identity);
  if (!parsed.success) throw absent();
  return parsed.data;
}
function id(value: string) {
  const parsed = projectIdSchema.safeParse(value);
  if (!parsed.success) throw invalid();
  return parsed.data;
}
function filePath(value: string) {
  const parsed = workspacePathSchema.safeParse(value);
  if (!parsed.success) throw invalid();
  return parsed.data;
}
function highest(...levels: (DataLevel | null | undefined)[]): DataLevel {
  return levels.includes('confidential') ? 'confidential' : 'internal';
}
function toWorkspace(row: Record<string, unknown>) {
  if (!row.currentVersionId)
    throw new AppError(
      409,
      'WORKSPACE_NOT_INITIALIZED',
      '项目工作区尚未准备好，请联系维护人员初始化后重试。',
    );
  return workspaceRecordSchema.parse({
    ...row,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}
function toDraft(row: Record<string, unknown>) {
  return workspaceDraftRecordSchema.parse({
    ...row,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}
function toVersion(row: Record<string, unknown>) {
  return workspaceVersionRecordSchema.parse({ ...row, createdAt: iso(row.createdAt) });
}
function toFile(row: Record<string, unknown>) {
  return workspaceFileRecordSchema.parse({ ...row, byteSize: Number(row.byteSize) });
}
function sorted(manifest: Manifest) {
  return [...manifest.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function activeActor(client: PoolClient, identity: BrowserIdentity) {
  const result = await client.query(
    "SELECT id FROM app_user WHERE id=$1 AND status='active' FOR SHARE",
    [identity.userId],
  );
  if (!result.rowCount) throw absent();
}
async function mutation<T>(
  pool: Pool,
  identity: BrowserIdentity,
  action: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await activeActor(client, identity);
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError(
      500,
      'WORKSPACE_WRITE_FAILED',
      '工作区写入失败，本次数据库修改已撤销，请检查依赖服务后重试。',
    );
  } finally {
    client.release();
  }
}

async function workspaceAccess(
  database: Executor,
  identity: BrowserIdentity,
  workspaceId: string,
  write = false,
  lock = false,
) {
  const result = await database.query<Record<string, unknown>>(
    `SELECT ${workspaceFields},p.owner_user_id AS "projectOwnerId" FROM workspace w JOIN cert_project p ON p.id=w.project_id
     WHERE w.id=$1 AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=$2 AND u.status='active')${lock ? ' FOR UPDATE OF w' : ''}`,
    [workspaceId, identity.userId],
  );
  const row = result.rows[0];
  if (!row) throw absent();
  if (
    !authorize(identity, write ? 'workspace.write' : 'workspace.read', {
      projectId: row.projectId,
      ownerUserId: row.projectOwnerId,
    })
  )
    throw absent();
  const { projectOwnerId: _owner, ...record } = row;
  return toWorkspace(record);
}
async function currentVersion(database: Executor, workspace: Workspace) {
  const result = await database.query<Record<string, unknown>>(
    `SELECT ${versionFields} FROM workspace_version v WHERE v.id=$1 AND v.workspace_id=$2`,
    [workspace.currentVersionId, workspace.id],
  );
  if (!result.rows[0]) throw absent();
  return toVersion(result.rows[0]);
}
function requireExecution(conversation: Conversation) {
  if (conversation.status !== 'active')
    throw new AppError(
      403,
      'WORKSPACE_CONVERSATION_INACTIVE',
      '会话已归档，不能继续写入；请在项目中新建执行模式对话。',
    );
  if (conversation.mode !== 'execute')
    throw new AppError(
      403,
      'WORKSPACE_READ_ONLY',
      '当前对话是只读检查模式，不能修改、保存或恢复工作区。',
    );
}
async function draftContext(
  database: Executor,
  identity: BrowserIdentity,
  draftId: string,
  write = false,
): Promise<DraftContext> {
  const located = await database.query<{ workspace_id: string }>(
    'SELECT workspace_id FROM workspace_draft WHERE id=$1 AND owner_user_id=$2',
    [draftId, identity.userId],
  );
  if (!located.rows[0]) throw absent();
  const workspace = await workspaceAccess(
    database,
    identity,
    located.rows[0].workspace_id,
    write,
    write,
  );
  const conversations = await database.query<Conversation>(
    `SELECT c.id,c.project_id,c.user_id,c.mode,c.status,c.max_data_level FROM conversation c
     JOIN workspace_draft d ON d.conversation_id=c.id WHERE d.id=$1 AND c.user_id=$2${write ? ' FOR UPDATE OF c' : ''}`,
    [draftId, identity.userId],
  );
  const conversation = conversations.rows[0];
  if (!conversation || conversation.project_id !== workspace.projectId) throw absent();
  if (write) requireExecution(conversation);
  const drafts = await database.query<Record<string, unknown>>(
    `SELECT ${draftFields} FROM workspace_draft d WHERE d.id=$1 AND d.owner_user_id=$2${write ? ' FOR UPDATE OF d' : ''}`,
    [draftId, identity.userId],
  );
  if (!drafts.rows[0]) throw absent();
  const draft = toDraft(drafts.rows[0]);
  if (draft.workspaceId !== workspace.id || draft.projectId !== conversation.project_id)
    throw absent();
  return { workspace, draft, conversation };
}

async function manifest(database: Executor, versionId: string): Promise<Manifest> {
  const result = await database.query<Record<string, unknown>>(
    `SELECT ${fileFields} FROM workspace_file WHERE version_id=$1 LIMIT $2`,
    [versionId, maxFiles + 1],
  );
  if (result.rows.length > maxFiles)
    throw new AppError(
      413,
      'WORKSPACE_FILE_LIMIT',
      '工作区文件超过10000项，请联系维护人员拆分工作区。',
    );
  const files: Manifest = new Map();
  for (const row of result.rows) {
    const file = toFile(row);
    if (files.has(file.path))
      throw new AppError(
        409,
        'WORKSPACE_PATH_COLLISION',
        '工作区存在规范化后重复的文件路径，请联系维护人员处理。',
      );
    files.set(file.path, file);
  }
  return files;
}
async function effectiveFiles(database: Executor, draft: Draft) {
  const files = await manifest(database, draft.baseVersionId);
  const result = await database.query<Record<string, unknown>>(
    `SELECT ${fileFields},is_deleted AS "isDeleted" FROM workspace_draft_file WHERE draft_id=$1 LIMIT $2`,
    [draft.id, maxFiles + 1],
  );
  if (result.rows.length > maxFiles)
    throw new AppError(
      413,
      'WORKSPACE_FILE_LIMIT',
      '工作副本改动文件过多，请联系维护人员拆分任务。',
    );
  for (const row of result.rows) {
    const path = filePath(String(row.path));
    if (row.isDeleted) files.delete(path);
    else {
      const { isDeleted: _deleted, ...file } = row;
      files.set(path, toFile(file));
    }
  }
  if (files.size > maxFiles)
    throw new AppError(
      413,
      'WORKSPACE_FILE_LIMIT',
      '工作区文件超过10000项，请联系维护人员拆分任务。',
    );
  return files;
}
async function audit(
  client: PoolClient,
  identity: BrowserIdentity,
  action: string,
  targetType: string,
  targetId: string,
  before: unknown,
  after: unknown,
) {
  await client.query(
    `INSERT INTO audit_log(actor_user_id,actor_kind,action,target_type,target_id,before_hash,after_hash)
    VALUES($1,'agent',$2,$3,$4,$5,$6)`,
    [
      identity.userId,
      action,
      targetType,
      targetId,
      before === null ? null : digest(before),
      digest(after),
    ],
  );
}
async function raiseWorkspaceLevel(client: PoolClient, workspace: Workspace, level: DataLevel) {
  if (level === workspace.dataLevel) return workspace;
  const result = await client.query<Record<string, unknown>>(
    `UPDATE workspace w SET data_level=$1,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$2 RETURNING ${workspaceFields}`,
    [level, workspace.id],
  );
  if (!result.rows[0]) throw absent();
  return toWorkspace(result.rows[0]);
}

export async function getWorkspaceByProject(
  pool: Pool,
  identity: BrowserIdentity,
  projectId: string,
) {
  const viewer = actor(identity);
  const found = await pool.query<{ id: string }>('SELECT id FROM workspace WHERE project_id=$1', [
    id(projectId),
  ]);
  if (!found.rows[0]) throw absent();
  return workspaceAccess(pool, viewer, found.rows[0].id);
}

export async function createDraft(pool: Pool, identity: BrowserIdentity, conversationId: string) {
  const viewer = actor(identity);
  const conversationKey = id(conversationId);
  return mutation(pool, viewer, async (client) => {
    const located = await client.query<{ workspace_id: string }>(
      `SELECT w.id AS workspace_id FROM conversation c JOIN workspace w ON w.project_id=c.project_id WHERE c.id=$1 AND c.user_id=$2`,
      [conversationKey, viewer.userId],
    );
    if (!located.rows[0]) throw absent();
    const workspace = await workspaceAccess(
      client,
      viewer,
      located.rows[0].workspace_id,
      true,
      true,
    );
    const conversations = await client.query<Conversation>(
      'SELECT id,project_id,user_id,mode,status,max_data_level FROM conversation WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [conversationKey, viewer.userId],
    );
    const conversation = conversations.rows[0];
    if (!conversation || conversation.project_id !== workspace.projectId) throw absent();
    requireExecution(conversation);
    const existing = await client.query<Record<string, unknown>>(
      `SELECT ${draftFields} FROM workspace_draft d WHERE d.conversation_id=$1 FOR UPDATE`,
      [conversationKey],
    );
    if (existing.rows[0]) {
      const before = toDraft(existing.rows[0]);
      if (before.ownerUserId !== viewer.userId || before.workspaceId !== workspace.id)
        throw absent();
      const level = highest(workspace.dataLevel, before.dataLevel, conversation.max_data_level);
      await raiseWorkspaceLevel(client, workspace, level);
      if (level === before.dataLevel) return before;
      const changed = await client.query<Record<string, unknown>>(
        `UPDATE workspace_draft d SET data_level=$1,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$2 RETURNING ${draftFields}`,
        [level, before.id],
      );
      const draft = toDraft(changed.rows[0]!);
      await audit(
        client,
        viewer,
        'workspace.draft_classified',
        'workspace_draft',
        draft.id,
        before,
        draft,
      );
      return draft;
    }
    const base = await currentVersion(client, workspace);
    const level = highest(workspace.dataLevel, base.dataLevel, conversation.max_data_level);
    await raiseWorkspaceLevel(client, workspace, level);
    const inserted = await client.query<Record<string, unknown>>(
      `INSERT INTO workspace_draft AS d(workspace_id,project_id,conversation_id,owner_user_id,base_version_id,data_level)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING ${draftFields}`,
      [workspace.id, workspace.projectId, conversationKey, viewer.userId, base.id, level],
    );
    const draft = toDraft(inserted.rows[0]!);
    await audit(
      client,
      viewer,
      'workspace.draft_created',
      'workspace_draft',
      draft.id,
      null,
      draft,
    );
    return draft;
  });
}

function fileList(files: Manifest, options: unknown, level: DataLevel) {
  const parsed = workspaceFileListOptionsSchema.safeParse(options);
  if (!parsed.success) throw invalid();
  const page = parsed.data;
  const visible = sorted(files).filter((file) => !page.cursor || file.path > page.cursor);
  const hasMore = visible.length > page.limit;
  const items = visible
    .slice(0, page.limit)
    .map((file) => ({ ...file, dataLevel: highest(file.dataLevel, level) }));
  return workspaceFileListSchema.parse({
    items,
    hasMore,
    nextCursor: hasMore ? (items.at(-1)?.path ?? null) : null,
  });
}
export async function listVersions(
  pool: Pool,
  identity: BrowserIdentity,
  workspaceId: string,
  options: unknown = {},
) {
  const viewer = actor(identity);
  const workspace = await workspaceAccess(pool, viewer, id(workspaceId));
  const parsed = workspaceVersionListOptionsSchema.safeParse(options);
  if (!parsed.success || parsed.data.afterNumber > 2147483647) throw invalid();
  const page = parsed.data;
  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${versionFields} FROM workspace_version v WHERE v.workspace_id=$1 AND v.number>$2 AND v.number<=(SELECT number FROM workspace_version WHERE id=$3) ORDER BY v.number LIMIT $4`,
    [workspace.id, page.afterNumber, workspace.currentVersionId, page.limit + 1],
  );
  const hasMore = result.rows.length > page.limit;
  const items = result.rows
    .slice(0, page.limit)
    .map((row) =>
      toVersion({ ...row, dataLevel: highest(row.dataLevel as DataLevel, workspace.dataLevel) }),
    );
  return workspaceVersionListSchema.parse({
    items,
    hasMore,
    nextAfterNumber: hasMore ? (items.at(-1)?.number ?? null) : null,
  });
}
async function versionAccess(pool: Pool, identity: BrowserIdentity, versionId: string) {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${versionFields} FROM workspace_version v JOIN workspace w ON w.id=v.workspace_id WHERE v.id=$1 AND v.number<=(SELECT number FROM workspace_version WHERE id=w.current_version_id)`,
    [id(versionId)],
  );
  if (!result.rows[0]) throw absent();
  const version = toVersion(result.rows[0]);
  const workspace = await workspaceAccess(pool, identity, version.workspaceId);
  return { workspace, version };
}
export async function listVersionFiles(
  pool: Pool,
  identity: BrowserIdentity,
  versionId: string,
  options: unknown = {},
) {
  const context = await versionAccess(pool, actor(identity), versionId);
  return fileList(
    await manifest(pool, context.version.id),
    options,
    highest(context.workspace.dataLevel, context.version.dataLevel),
  );
}
export async function listDraftFiles(
  pool: Pool,
  identity: BrowserIdentity,
  draftId: string,
  options: unknown = {},
) {
  const context = await draftContext(pool, actor(identity), id(draftId));
  return fileList(
    await effectiveFiles(pool, context.draft),
    options,
    highest(
      context.workspace.dataLevel,
      context.draft.dataLevel,
      context.conversation.max_data_level,
    ),
  );
}

export async function getDraft(pool: Pool, identity: BrowserIdentity, draftId: string) {
  const context = await draftContext(pool, actor(identity), id(draftId));
  return workspaceDraftRecordSchema.parse({
    ...context.draft,
    dataLevel: highest(
      context.workspace.dataLevel,
      context.draft.dataLevel,
      context.conversation.max_data_level,
    ),
  });
}

export async function rebaseDraft(
  pool: Pool,
  store: DocumentBlobStore,
  identity: BrowserIdentity,
  draftId: string,
  input: unknown,
) {
  const viewer = actor(identity),
    draftKey = id(draftId);
  const parsed = workspaceRebaseSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  const request = parsed.data;
  return mutation(pool, viewer, async (client) => {
    const context = await draftContext(client, viewer, draftKey, true);
    if (
      context.draft.version !== request.expectedDraftVersion ||
      context.workspace.currentVersionId !== request.expectedCurrentVersionId
    ) {
      throw new AppError(
        409,
        'WORKSPACE_REBASE_STALE',
        '工作副本或当前工作区版本已经改变，请重新读取版本与差异后再确认重基。',
        { changedPaths: [], truncated: false },
      );
    }
    const base = await manifest(client, context.draft.baseVersionId);
    const current = await manifest(client, context.workspace.currentVersionId);
    const effective = await effectiveFiles(client, context.draft);
    await decisionAppend(store, base, effective);
    const overlays = await client.query<Record<string, unknown>>(
      `SELECT ${fileFields},is_deleted AS "isDeleted" FROM workspace_draft_file WHERE draft_id=$1 ORDER BY path LIMIT $2`,
      [draftKey, maxFiles + 1],
    );
    if (overlays.rows.length > maxFiles)
      throw new AppError(413, 'WORKSPACE_FILE_LIMIT', '工作副本文件过多，请联系维护人员拆分任务。');
    const overlayPaths = new Set(overlays.rows.map((row) => filePath(String(row.path))));
    const changedCurrent = new Set(
      compareFileManifests(sorted(base), sorted(current)).map((change) => change.path),
    );
    const differsFromCurrent = new Set(
      compareFileManifests(sorted(current), sorted(effective)).map((change) => change.path),
    );
    const conflicts = [...overlayPaths]
      .filter((path) => changedCurrent.has(path) && differsFromCurrent.has(path))
      .sort();
    const confirmations = new Map(
      request.resolutions.map((resolution) => [resolution.path, resolution]),
    );
    for (const resolution of request.resolutions) {
      if (
        !overlayPaths.has(resolution.path) ||
        resolution.expectedCurrentSha256 !== (current.get(resolution.path)?.sha256 ?? null) ||
        resolution.expectedDraftSha256 !== (effective.get(resolution.path)?.sha256 ?? null)
      ) {
        throw new AppError(
          409,
          'WORKSPACE_REBASE_STALE',
          '冲突确认中的文件哈希已变化或路径不属于本次改动，请重新读取双方文件后确认。',
          { changedPaths: [resolution.path], truncated: false },
        );
      }
    }
    const unconfirmed = conflicts.filter((path) => !confirmations.has(path));
    if (unconfirmed.length) {
      throw new AppError(
        409,
        'WORKSPACE_REBASE_CONFLICT',
        '这些路径双方都有改动。请先读取当前版本与工作副本，完成手动合并，再逐路径确认双方实际哈希。',
        { changedPaths: unconfirmed.slice(0, 20), truncated: unconfirmed.length > 20 },
      );
    }
    const merged = new Map(current);
    for (const path of overlayPaths) {
      const file = effective.get(path);
      if (file) merged.set(path, file);
      else merged.delete(path);
    }
    if (merged.size > maxFiles) {
      throw new AppError(
        413,
        'WORKSPACE_FILE_LIMIT',
        '重基后的联合清单将超过10000项，本副本未改动。请缩小改动范围，或联系维护人员拆分工作区后重试。',
      );
    }
    try {
      await decisionAppend(store, current, merged);
    } catch (error) {
      if (error instanceof AppError && error.code === 'WORKSPACE_DECISIONS_APPEND_ONLY') {
        throw new AppError(
          409,
          'WORKSPACE_DECISIONS_REBASE_CONFLICT',
          '决定记录历史已经分叉，不能自动重排或删除。请从最新版本新建对话，再逐条追加尚未保存的决定；本副本保持不变。',
          { changedPaths: [decisionPath], truncated: false },
        );
      }
      throw error;
    }
    const removed = [...overlayPaths].filter((path) => !differsFromCurrent.has(path));
    const level = highest(
      context.workspace.dataLevel,
      context.draft.dataLevel,
      context.conversation.max_data_level,
      ...[...current.values()].map((file) => file.dataLevel),
      ...overlays.rows.map((row) => row.dataLevel as DataLevel),
    );
    if (
      context.draft.baseVersionId === context.workspace.currentVersionId &&
      removed.length === 0 &&
      level === context.draft.dataLevel &&
      level === context.workspace.dataLevel
    ) {
      return workspaceRebaseResultSchema.parse({ draft: context.draft });
    }
    if (removed.length)
      await client.query(
        'DELETE FROM workspace_draft_file WHERE draft_id=$1 AND path=ANY($2::text[])',
        [draftKey, removed],
      );
    await client.query(
      'UPDATE workspace_draft_file SET data_level=GREATEST(data_level,$1::document_data_level),updated_at=CURRENT_TIMESTAMP WHERE draft_id=$2',
      [level, draftKey],
    );
    const result = await client.query<Record<string, unknown>>(
      `UPDATE workspace_draft d SET base_version_id=$1,data_level=$2,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$3 RETURNING ${draftFields}`,
      [context.workspace.currentVersionId, level, draftKey],
    );
    const draft = toDraft(result.rows[0]!);
    await raiseWorkspaceLevel(client, context.workspace, level);
    await audit(
      client,
      viewer,
      'workspace.rebased',
      'workspace_draft',
      draft.id,
      {
        draftVersion: context.draft.version,
        baseVersionId: context.draft.baseVersionId,
        overlay: overlays.rows,
      },
      {
        draftVersion: draft.version,
        baseVersionId: draft.baseVersionId,
        overlay: overlays.rows
          .filter((row) => !removed.includes(String(row.path)))
          .map((row) => ({ ...row, dataLevel: highest(row.dataLevel as DataLevel, level) })),
      },
    );
    return workspaceRebaseResultSchema.parse({ draft });
  });
}
async function readFile(
  store: DocumentBlobStore,
  file: FileRecord,
  context: { workspaceId: string; versionId: string; draftId: string | null; dataLevel: DataLevel },
  options: unknown,
) {
  const bytes = await store.get(file.sha256);
  if (bytes.byteLength !== file.byteSize)
    throw new AppError(
      500,
      'WORKSPACE_CONTENT_MISMATCH',
      '文件大小与版本记录不一致，已拒绝读取，请联系维护人员。',
    );
  const text = decodeUtf8Text(bytes);
  return workspaceReadFileSchema.parse({
    ...file,
    workspaceId: context.workspaceId,
    versionId: context.versionId,
    draftId: context.draftId,
    dataLevel: highest(file.dataLevel, context.dataLevel),
    ...sliceUnicodeText(text, options),
  });
}
export async function readVersionFile(
  pool: Pool,
  store: DocumentBlobStore,
  identity: BrowserIdentity,
  versionId: string,
  path: string,
  options: unknown = {},
) {
  const context = await versionAccess(pool, actor(identity), versionId);
  const file = (await manifest(pool, context.version.id)).get(filePath(path));
  if (!file) throw absent();
  return readFile(
    store,
    file,
    {
      workspaceId: context.workspace.id,
      versionId: context.version.id,
      draftId: null,
      dataLevel: highest(context.workspace.dataLevel, context.version.dataLevel),
    },
    options,
  );
}
export async function readDraftFile(
  pool: Pool,
  store: DocumentBlobStore,
  identity: BrowserIdentity,
  draftId: string,
  path: string,
  options: unknown = {},
) {
  const context = await draftContext(pool, actor(identity), id(draftId));
  const file = (await effectiveFiles(pool, context.draft)).get(filePath(path));
  if (!file) throw absent();
  return readFile(
    store,
    file,
    {
      workspaceId: context.workspace.id,
      versionId: context.draft.baseVersionId,
      draftId: context.draft.id,
      dataLevel: highest(
        context.workspace.dataLevel,
        context.draft.dataLevel,
        context.conversation.max_data_level,
      ),
    },
    options,
  );
}

async function decisionAppend(store: DocumentBlobStore, before: Manifest, after: Manifest) {
  const old = before.get(decisionPath),
    next = after.get(decisionPath);
  if (!old) {
    if (next) decodeUtf8Text(await store.get(next.sha256));
    return;
  }
  if (!next)
    throw new AppError(
      403,
      'WORKSPACE_DECISIONS_APPEND_ONLY',
      '决定记录只能在末尾追加，不能删除；请保留现有记录后重试。',
    );
  const oldText = decodeUtf8Text(await store.get(old.sha256));
  const newText = decodeUtf8Text(await store.get(next.sha256));
  if (!newText.startsWith(oldText))
    throw new AppError(
      403,
      'WORKSPACE_DECISIONS_APPEND_ONLY',
      '决定记录只能在末尾追加，请先读取现有记录并保留完整原文。',
    );
}
export async function writeDraftFile(
  pool: Pool,
  store: DocumentBlobStore,
  identity: BrowserIdentity,
  draftId: string,
  input: unknown,
) {
  const viewer = actor(identity);
  const draftKey = id(draftId);
  const parsed = workspaceWriteFileSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  const data = parsed.data;
  return mutation(pool, viewer, async (client) => {
    const context = await draftContext(client, viewer, draftKey, true);
    const files = await effectiveFiles(client, context.draft);
    const prior = files.get(data.path);
    if ((prior?.sha256 ?? null) !== data.expectedSha256)
      throw new AppError(
        409,
        'WORKSPACE_FILE_CONFLICT',
        '文件已改变，请重新读取该文件的当前哈希，再应用修改。',
        { changedPaths: [data.path], truncated: false },
      );
    if (!prior && files.size >= maxFiles)
      throw new AppError(
        413,
        'WORKSPACE_FILE_LIMIT',
        '工作区文件超过10000项，请联系维护人员拆分任务。',
      );
    if (data.path === decisionPath) {
      await decisionAppend(store, await manifest(client, context.draft.baseVersionId), files);
      if (prior && !data.content.startsWith(decodeUtf8Text(await store.get(prior.sha256)))) {
        throw new AppError(
          403,
          'WORKSPACE_DECISIONS_APPEND_ONLY',
          '决定记录只能在末尾追加，请先读取现有记录并保留完整原文。',
        );
      }
    }
    const level = highest(
      context.workspace.dataLevel,
      context.draft.dataLevel,
      context.conversation.max_data_level,
      prior?.dataLevel,
    );
    const bytes = Buffer.from(data.content, 'utf8');
    const stored = await store.put(bytes);
    if (
      stored.sha256 !== createHash('sha256').update(bytes).digest('hex') ||
      stored.byteSize !== bytes.byteLength
    )
      throw new AppError(
        500,
        'WORKSPACE_CONTENT_MISMATCH',
        '存储返回的内容校验不一致，本次修改未登记。',
      );
    const file = workspaceFileRecordSchema.parse({
      path: data.path,
      sha256: stored.sha256,
      byteSize: stored.byteSize,
      dataLevel: level,
      mediaType: data.path.toLowerCase().endsWith('.md')
        ? 'text/markdown; charset=utf-8'
        : 'text/plain; charset=utf-8',
    });
    const after = new Map(files);
    after.set(file.path, file);
    if (file.path === decisionPath) await decisionAppend(store, files, after);
    await client.query(
      `INSERT INTO workspace_draft_file(draft_id,path,sha256,byte_size,data_level,media_type,is_deleted)
      VALUES($1,$2,$3,$4,$5,$6,false) ON CONFLICT(draft_id,path) DO UPDATE SET sha256=EXCLUDED.sha256,byte_size=EXCLUDED.byte_size,data_level=EXCLUDED.data_level,media_type=EXCLUDED.media_type,is_deleted=false,updated_at=CURRENT_TIMESTAMP`,
      [draftKey, file.path, file.sha256, file.byteSize, file.dataLevel, file.mediaType],
    );
    const result = await client.query<Record<string, unknown>>(
      `UPDATE workspace_draft d SET data_level=$1,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$2 RETURNING ${draftFields}`,
      [level, draftKey],
    );
    await raiseWorkspaceLevel(client, context.workspace, level);
    const draft = toDraft(result.rows[0]!);
    await audit(
      client,
      viewer,
      'workspace.file_written',
      'workspace_draft',
      draft.id,
      { draftVersion: context.draft.version, file: prior ?? null },
      { draftVersion: draft.version, file },
    );
    return workspaceWriteResultSchema.parse({ draft, file });
  });
}

async function assertCurrentBase(client: PoolClient, context: DraftContext) {
  if (context.draft.baseVersionId === context.workspace.currentVersionId) return;
  const changes = compareFileManifests(
    sorted(await manifest(client, context.draft.baseVersionId)),
    sorted(await manifest(client, context.workspace.currentVersionId)),
  );
  throw new AppError(
    409,
    'WORKSPACE_CONFLICT',
    '工作区已由其他对话保存，请查看差异并合并后重试。',
    {
      changedPaths: changes.slice(0, 20).map((change) => change.path),
      truncated: changes.length > 20,
    },
  );
}
async function persistVersion(
  client: PoolClient,
  identity: BrowserIdentity,
  context: DraftContext,
  files: Manifest,
  summary: string,
  action: string,
) {
  const parent = await currentVersion(client, context.workspace);
  const level = highest(
    context.workspace.dataLevel,
    context.draft.dataLevel,
    context.conversation.max_data_level,
    ...[...files.values()].map((file) => file.dataLevel),
  );
  const published = sorted(files).map((file) => ({
    ...file,
    dataLevel: highest(file.dataLevel, level),
  }));
  const inserted = await client.query<Record<string, unknown>>(
    `INSERT INTO workspace_version AS v(workspace_id,project_id,number,parent_version_id,author_user_id,author_type,summary,data_level)
    VALUES($1,$2,$3,$4,$5,'ai',$6,$7) RETURNING ${versionFields}`,
    [
      context.workspace.id,
      context.workspace.projectId,
      parent.number + 1,
      parent.id,
      identity.userId,
      summary,
      level,
    ],
  );
  const version = toVersion(inserted.rows[0]!);
  await client.query(
    `INSERT INTO workspace_file(version_id,path,sha256,byte_size,data_level,media_type)
    SELECT $1,f.path,f.sha256,f."byteSize",f."dataLevel"::document_data_level,f."mediaType"
    FROM jsonb_to_recordset($2::jsonb) AS f(path text,sha256 text,"byteSize" bigint,"dataLevel" text,"mediaType" text)`,
    [version.id, JSON.stringify(published)],
  );
  await client.query(
    'UPDATE workspace SET current_version_id=$1,data_level=$2,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$3',
    [version.id, level, context.workspace.id],
  );
  const result = await client.query<Record<string, unknown>>(
    `UPDATE workspace_draft d SET base_version_id=$1,data_level=$2,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$3 RETURNING ${draftFields}`,
    [version.id, level, context.draft.id],
  );
  await client.query('DELETE FROM workspace_draft_file WHERE draft_id=$1', [context.draft.id]);
  const draft = toDraft(result.rows[0]!);
  await audit(
    client,
    identity,
    action,
    'workspace_version',
    version.id,
    { baseVersionId: parent.id },
    { versionId: version.id, files: published },
  );
  return workspaceSaveResultSchema.parse({ version, draft });
}
export async function saveDraft(
  pool: Pool,
  store: DocumentBlobStore,
  identity: BrowserIdentity,
  draftId: string,
  summary: string,
) {
  const viewer = actor(identity),
    draftKey = id(draftId);
  const parsed = workspaceSaveSchema.safeParse({ summary });
  if (!parsed.success) throw invalid();
  return mutation(pool, viewer, async (client) => {
    const context = await draftContext(client, viewer, draftKey, true);
    await assertCurrentBase(client, context);
    const base = await manifest(client, context.draft.baseVersionId),
      files = await effectiveFiles(client, context.draft);
    await decisionAppend(store, base, files);
    for (const file of files.values()) {
      const bytes = await store.get(file.sha256);
      if (bytes.byteLength !== file.byteSize)
        throw new AppError(
          500,
          'WORKSPACE_CONTENT_MISMATCH',
          '文件内容与工作副本记录不一致，已停止保存，请重新读取并核对。',
        );
    }
    return persistVersion(client, viewer, context, files, parsed.data.summary, 'workspace.saved');
  });
}
export async function restoreVersion(
  pool: Pool,
  store: DocumentBlobStore,
  identity: BrowserIdentity,
  draftId: string,
  targetVersionId: string,
  summary: string,
) {
  const viewer = actor(identity),
    draftKey = id(draftId);
  const parsed = workspaceRestoreSchema.safeParse({ targetVersionId, summary });
  if (!parsed.success) throw invalid();
  return mutation(pool, viewer, async (client) => {
    const context = await draftContext(client, viewer, draftKey, true);
    await assertCurrentBase(client, context);
    const target = await client.query<{ id: string }>(
      `SELECT id FROM workspace_version WHERE id=$1 AND workspace_id=$2 AND number<=(SELECT number FROM workspace_version WHERE id=$3)`,
      [parsed.data.targetVersionId, context.workspace.id, context.workspace.currentVersionId],
    );
    if (!target.rows[0]) throw absent();
    const base = await manifest(client, context.draft.baseVersionId),
      current = await effectiveFiles(client, context.draft);
    await decisionAppend(store, base, current);
    const files = await manifest(client, target.rows[0].id);
    const latestDecision = current.get(decisionPath);
    if (latestDecision) files.set(decisionPath, latestDecision);
    for (const file of files.values()) {
      const bytes = await store.get(file.sha256);
      if (bytes.byteLength !== file.byteSize)
        throw new AppError(
          500,
          'WORKSPACE_CONTENT_MISMATCH',
          '历史文件内容校验失败，不能恢复，请联系维护人员。',
        );
    }
    return persistVersion(
      client,
      viewer,
      context,
      files,
      parsed.data.summary,
      'workspace.restored',
    );
  });
}
