import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  serviceIdentitySchema,
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
  workspaceUndoOverlaySchema,
  workspaceUndoSnapshotSchema,
  workspaceToolUndoStateSchema,
  humanRevisionListSchema,
  humanRevisionSourceSchema,
  humanRevisionViewSchema,
  humanRevisionMaxBytes,
  humanRevisionMaxWordBytes,
  humanRevisionWordPathPattern,
  reviewDiffSchema,
  type BrowserIdentity,
  type HumanRevisionCommand,
  type WorkspaceToolUndoState,
  type ServiceIdentity,
  type DataLevel,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { authorize } from '../auth/authorization.js';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import type { DocumentParserClient } from '../documents/docsvc-client.js';
import { compareFileManifests } from './diff.js';
import { decodeUtf8Text, sliceUnicodeText } from './text.js';
import { compareHumanRevision, compareRevisionParagraphs } from './paragraph-diff.js';

type Executor = Pool | PoolClient;
type Workspace = ReturnType<typeof workspaceRecordSchema.parse>;
type Draft = ReturnType<typeof workspaceDraftRecordSchema.parse>;
type FileRecord = ReturnType<typeof workspaceFileRecordSchema.parse>;
type Manifest = Map<string, FileRecord>;
type Conversation = {
  id: string;
  project_id: string | null;
  user_id: string;
  permission_mode: string;
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
function actor(identity: ServiceIdentity) {
  const parsed = serviceIdentitySchema.safeParse(identity);
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

async function activeActor(client: PoolClient, identity: ServiceIdentity) {
  const result = await client.query(
    "SELECT id FROM app_user WHERE id=$1 AND status='active' FOR SHARE",
    [identity.userId],
  );
  if (!result.rowCount) throw absent();
}
async function mutation<T>(
  pool: Executor,
  identity: ServiceIdentity,
  action: (client: PoolClient) => Promise<T>,
) {
  if ('release' in pool) {
    await activeActor(pool, identity);
    return action(pool);
  }
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
  identity: ServiceIdentity,
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
      '会话已归档，不能继续写入；请在项目中新建对话。',
    );
  if (!['ask', 'full'].includes(conversation.permission_mode))
    throw new AppError(
      403,
      'WORKSPACE_READ_ONLY',
      '当前对话是只读检查模式，不能修改、保存或恢复工作区。',
    );
}
async function draftContext(
  database: Executor,
  identity: ServiceIdentity,
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
    `SELECT c.id,c.project_id,c.user_id,c.permission_mode,c.status,c.max_data_level FROM conversation c
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
  identity: ServiceIdentity,
  action: string,
  targetType: string,
  targetId: string,
  before: unknown,
  after: unknown,
) {
  await client.query(
    `INSERT INTO audit_log(actor_user_id,actor_kind,action,target_type,target_id,before_hash,after_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      identity.userId,
      identity.kind,
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
  pool: Executor,
  identity: ServiceIdentity,
  projectId: string,
) {
  const viewer = actor(identity);
  const found = await pool.query<{ id: string }>('SELECT id FROM workspace WHERE project_id=$1', [
    id(projectId),
  ]);
  if (!found.rows[0]) throw absent();
  return workspaceAccess(pool, viewer, found.rows[0].id);
}

export async function createDraft(
  pool: Executor,
  identity: ServiceIdentity,
  conversationId: string,
) {
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
      'SELECT id,project_id,user_id,permission_mode,status,max_data_level FROM conversation WHERE id=$1 AND user_id=$2 FOR UPDATE',
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
  pool: Executor,
  identity: ServiceIdentity,
  workspaceId: string,
  options: unknown = {},
) {
  const viewer = actor(identity);
  const workspace = await workspaceAccess(pool, viewer, id(workspaceId));
  const parsed = workspaceVersionListOptionsSchema.safeParse(options);
  if (!parsed.success || parsed.data.afterNumber > 2147483647) throw invalid();
  const page = parsed.data;
  const recent = page.view === 'recent';
  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${versionFields} FROM workspace_version v WHERE v.workspace_id=$1 AND v.number>$2
    AND v.number<=(SELECT number FROM workspace_version WHERE id=$3)
    ORDER BY v.number ${recent ? 'DESC' : 'ASC'} LIMIT $4`,
    [
      workspace.id,
      page.afterNumber,
      workspace.currentVersionId,
      recent ? page.limit : page.limit + 1,
    ],
  );
  const hasMore = !recent && result.rows.length > page.limit;
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
async function versionAccess(pool: Executor, identity: ServiceIdentity, versionId: string) {
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
  pool: Executor,
  identity: ServiceIdentity,
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
  pool: Executor,
  identity: ServiceIdentity,
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

export async function getDraft(pool: Executor, identity: ServiceIdentity, draftId: string) {
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
  pool: Executor,
  store: DocumentBlobStore,
  identity: ServiceIdentity,
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
  pool: Executor,
  store: DocumentBlobStore,
  identity: ServiceIdentity,
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
  pool: Executor,
  store: DocumentBlobStore,
  identity: ServiceIdentity,
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
  pool: Executor,
  store: DocumentBlobStore,
  identity: ServiceIdentity,
  draftId: string,
  input: unknown,
) {
  const parsed = workspaceWriteFileSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  const { path, content, expectedSha256 } = parsed.data;
  return writeDraftContent(pool, store, identity, draftId, {
    path,
    expectedSha256,
    bytes: Buffer.from(content, 'utf8'),
    decisionText: content,
    mediaType: path.toLowerCase().endsWith('.md')
      ? 'text/markdown; charset=utf-8'
      : 'text/plain; charset=utf-8',
  });
}

export async function writeDraftArtifact(
  pool: Executor,
  store: DocumentBlobStore,
  identity: ServiceIdentity,
  draftId: string,
  artifact: { path: string; bytes: Buffer; mediaType: string; dataLevel: DataLevel },
) {
  const path = filePath(artifact.path);
  if (path === decisionPath)
    throw new AppError(403, 'WORKSPACE_DECISIONS_APPEND_ONLY', '运行产出请另存到交付目录。');
  if (!Buffer.isBuffer(artifact.bytes) || artifact.bytes.byteLength > 12 * 1024 * 1024)
    throw new AppError(413, 'WORKSPACE_ARTIFACT_LIMIT', '单份运行产出超过 12 MiB，请拆分后重试。');
  return writeDraftContent(pool, store, identity, draftId, {
    ...artifact,
    path,
    expectedSha256: null,
  });
}

async function writeDraftContent(
  pool: Executor,
  store: DocumentBlobStore,
  identity: ServiceIdentity,
  draftId: string,
  data: {
    path: string;
    expectedSha256: string | null;
    bytes: Buffer;
    mediaType: string;
    decisionText?: string;
    dataLevel?: DataLevel;
  },
) {
  const viewer = actor(identity);
  const draftKey = id(draftId);
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
      if (prior && !data.decisionText?.startsWith(decodeUtf8Text(await store.get(prior.sha256)))) {
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
      data.dataLevel,
    );
    const bytes = data.bytes;
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
      mediaType: data.mediaType,
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
async function installWorkspaceVersion(
  client: PoolClient,
  identity: ServiceIdentity,
  workspace: Workspace,
  files: Manifest,
  summary: string,
  level: DataLevel,
) {
  const parent = await currentVersion(client, workspace);
  const published = sorted(files).map((file) => ({
    ...file,
    dataLevel: highest(file.dataLevel, level),
  }));
  const inserted = await client.query<Record<string, unknown>>(
    `INSERT INTO workspace_version AS v(workspace_id,project_id,number,parent_version_id,author_user_id,author_type,summary,data_level)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${versionFields}`,
    [
      workspace.id,
      workspace.projectId,
      parent.number + 1,
      parent.id,
      identity.userId,
      identity.kind === 'agent' ? 'ai' : 'human',
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
    [version.id, level, workspace.id],
  );
  return { version, parent, published };
}
async function persistVersion(
  client: PoolClient,
  identity: ServiceIdentity,
  context: DraftContext,
  files: Manifest,
  summary: string,
  action: string,
) {
  const level = highest(
    context.workspace.dataLevel,
    context.draft.dataLevel,
    context.conversation.max_data_level,
    ...[...files.values()].map((file) => file.dataLevel),
  );
  const { version, parent, published } = await installWorkspaceVersion(
    client,
    identity,
    context.workspace,
    files,
    summary,
    level,
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

const humanRevisionFields = `${versionFields},h.id AS "revisionId",h.review_id AS "reviewId",
  h.source_version_id AS "sourceVersionId",h.path,h.skill_id AS "skillId",
  h.skill_version AS "skillVersion",h.difference,h.fingerprint`;
function revisionView(row: Record<string, unknown>) {
  const {
    revisionId,
    reviewId,
    sourceVersionId,
    path,
    skillId,
    skillVersion,
    difference,
    fingerprint: _fingerprint,
    ...version
  } = row;
  return humanRevisionViewSchema.parse({
    id: revisionId,
    reviewId,
    sourceVersionId,
    path,
    skillId,
    skillVersion,
    difference,
    version: toVersion(version),
  });
}
type RevisionReview = {
  workspace_version_id: string;
  skill_id: string;
  skill_version: string;
  data_level: DataLevel;
  diff: unknown;
};
async function revisionReview(client: Executor, workspace: Workspace, reviewId: string) {
  const {
    rows: [row],
  } = await client.query<RevisionReview>(
    'SELECT workspace_version_id,skill_id,skill_version,data_level,diff FROM review_card WHERE id=$1 AND project_id=$2',
    [reviewId, workspace.projectId],
  );
  if (!row) throw absent();
  return row;
}

export async function findHumanRevisionSource(
  pool: Pool,
  identity: BrowserIdentity,
  workspaceId: string,
  versionId: string,
  path: string,
) {
  const workspace = await workspaceAccess(pool, identity, workspaceId, true);
  const {
    rows: [source],
  } = await pool.query(
    `SELECT r.id AS "reviewId",v.id AS "sourceVersionId",v.number AS "sourceVersionNumber"
     FROM review_card r
     JOIN workspace_version v ON v.id=r.workspace_version_id AND v.workspace_id=$1 AND v.author_type='ai'
     JOIN workspace_file original ON original.version_id=v.id AND original.path=$4
     JOIN workspace_version chosen ON chosen.id=$2 AND chosen.workspace_id=v.workspace_id
     JOIN workspace_file selected ON selected.version_id=chosen.id AND selected.path=original.path
     JOIN workspace_file head_file ON head_file.version_id=$3 AND head_file.path=original.path
     WHERE r.project_id=$5 AND v.number<=chosen.number
       AND selected.sha256=original.sha256 AND head_file.sha256=original.sha256
       AND head_file.byte_size=original.byte_size AND head_file.media_type=original.media_type
       AND r.diff->'changes' @> jsonb_build_array(jsonb_build_object('path',original.path,'afterSha256',original.sha256))
     ORDER BY v.number DESC,r.created_at DESC,r.id DESC LIMIT 1`,
    [workspace.id, versionId, workspace.currentVersionId, path, workspace.projectId],
  );
  return humanRevisionSourceSchema.parse({ source: source ?? null });
}

export async function listHumanRevisions(
  pool: Pool,
  identity: BrowserIdentity,
  workspaceId: string,
  reviewId: string,
  cursor?: string,
) {
  const workspace = await workspaceAccess(pool, identity, workspaceId);
  await revisionReview(pool, workspace, reviewId);
  if (
    cursor &&
    !(
      await pool.query(
        'SELECT 1 FROM human_revision WHERE id=$1 AND workspace_id=$2 AND review_id=$3',
        [cursor, workspace.id, reviewId],
      )
    ).rowCount
  )
    throw absent();
  const { rows } = await pool.query(
    `SELECT ${humanRevisionFields} FROM human_revision h
      JOIN workspace_version v ON v.id=h.new_version_id AND v.workspace_id=h.workspace_id
      WHERE h.workspace_id=$1 AND h.review_id=$2
        AND ($3::uuid IS NULL OR (h.created_at,h.id) < (SELECT created_at,id FROM human_revision WHERE id=$3))
      ORDER BY h.created_at DESC,h.id DESC LIMIT 6`,
    [workspace.id, reviewId, cursor ?? null],
  );
  const items = rows.slice(0, 5).map(revisionView);
  return humanRevisionListSchema.parse({
    items,
    nextCursor: rows.length > 5 ? items.at(-1)?.id : null,
  });
}

const staleHumanRevision = () =>
  new AppError(
    409,
    'HUMAN_REVISION_CONFLICT',
    '工作区或修改稿请求已经变化，请打开当前关联审核卡后重试。',
  );

async function priorHumanRevision(
  database: Executor,
  identity: BrowserIdentity,
  requestKey: string,
  fingerprint: string,
) {
  const {
    rows: [prior],
  } = await database.query(
    `SELECT ${humanRevisionFields} FROM human_revision h JOIN workspace_version v ON v.id=h.new_version_id
      WHERE h.author_id=$1 AND h.request_key=$2`,
    [identity.userId, requestKey],
  );
  if (!prior) return undefined;
  if (prior.fingerprint !== fingerprint) throw staleHumanRevision();
  return revisionView(prior);
}

export async function prepareHumanRevision(
  pool: Pool,
  store: DocumentBlobStore,
  identity: BrowserIdentity,
  workspaceId: string,
  input: HumanRevisionCommand & ({ text: string } | { bytes: Buffer }),
  parser?: Pick<DocumentParserClient, 'wordParagraphs'>,
) {
  const sourceId = input.sourceVersionId.toLowerCase();
  const expectedId = input.expectedCurrentVersionId.toLowerCase();
  const reviewId = input.reviewId.toLowerCase();
  const workspace = await workspaceAccess(pool, identity, workspaceId, true);
  const review = await revisionReview(pool, workspace, reviewId);
  const encoded = 'bytes' in input ? input.bytes : Buffer.from(input.text, 'utf8');
  const sha256 = createHash('sha256').update(encoded).digest('hex');
  const fingerprint = digest({
    workspaceId: workspace.id,
    reviewId,
    sourceId,
    expectedId,
    path: input.path,
    sha256,
    dataLevel: input.dataLevel,
  });
  const context = { sourceId, expectedId, reviewId, fingerprint };
  const findPrior = () => priorHumanRevision(pool, identity, input.requestKey, fingerprint);
  const prior = await findPrior();
  if (prior) return { ...context, alreadySaved: true } as const;
  if (workspace.currentVersionId !== expectedId || review.workspace_version_id !== sourceId) {
    const saved = await findPrior();
    if (saved) return { ...context, alreadySaved: true } as const;
    throw staleHumanRevision();
  }
  const source = await versionAccess(pool, identity, sourceId);
  const sourceFiles = await manifest(pool, sourceId);
  const before = expectedId === sourceId ? sourceFiles : await manifest(pool, expectedId);
  const original = sourceFiles.get(input.path);
  const changed = reviewDiffSchema
    .parse(review.diff)
    .changes.some(
      (change) => change.path === input.path && change.afterSha256 === original?.sha256,
    );
  if (source.version.authorType !== 'ai' || !original || !changed)
    throw new AppError(409, 'HUMAN_REVISION_SOURCE', '请选用当前审核卡中由 Agent 保存的文件。');
  const currentFile = before.get(input.path);
  if (
    !currentFile ||
    currentFile.sha256 !== original.sha256 ||
    currentFile.byteSize !== original.byteSize ||
    currentFile.mediaType !== original.mediaType
  )
    throw new AppError(
      409,
      'HUMAN_REVISION_FILE_CHANGED',
      '所选文件此后已有修改，请保留现有版本并重新核对。',
    );
  const word = 'bytes' in input;
  const mediaType = original.mediaType.split(';', 1)[0]?.trim().toLowerCase();
  const supported = word
    ? humanRevisionWordPathPattern.test(input.path) &&
      mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    : /\.(md|txt)$/iu.test(input.path) &&
      (mediaType === 'text/plain' || mediaType === 'text/markdown');
  if (!supported)
    throw new AppError(
      415,
      'HUMAN_REVISION_FORMAT',
      '请上传与原稿格式一致的 Word（.docx）、Markdown 或 UTF-8 纯文本。',
    );
  const maxBytes = word ? humanRevisionMaxWordBytes : humanRevisionMaxBytes;
  if (encoded.length === 0 || encoded.length > maxBytes || original.byteSize > maxBytes)
    throw new AppError(413, 'HUMAN_REVISION_DIFF_LIMIT', '原稿或修改稿超过当前对比大小上限。');
  if (word && !parser)
    throw new AppError(
      503,
      'DOCUMENT_PARSER_DISABLED',
      'Word 改稿对比需要本机解析服务，请联系维护人员启动。',
    );
  if (original.sha256 === sha256)
    throw new AppError(409, 'HUMAN_REVISION_UNCHANGED', '上传内容与原稿完全一致。');
  const rawBefore = await store.get(original.sha256);
  if (
    rawBefore.length !== original.byteSize ||
    createHash('sha256').update(rawBefore).digest('hex') !== original.sha256
  )
    throw new AppError(500, 'WORKSPACE_CONTENT_MISMATCH', '原稿与登记的版本不一致，请刷新后重试。');
  let difference;
  if ('text' in input) {
    const originalText = decodeUtf8Text(rawBefore);
    if (originalText.includes('\0'))
      throw new AppError(
        415,
        'HUMAN_REVISION_FORMAT',
        '原稿含二进制字符，请保存为 UTF-8 文本后核对。',
      );
    difference = compareHumanRevision(originalText, input.text);
  } else {
    const first = await parser!.wordParagraphs(rawBefore, original.sha256);
    const next = await parser!.wordParagraphs(encoded, sha256);
    difference = compareRevisionParagraphs(first, next);
  }
  return {
    ...context,
    alreadySaved: false,
    encoded,
    sha256,
    difference,
    before,
    original,
    currentFile,
  } as const;
}

export async function saveHumanRevision(
  client: PoolClient,
  store: DocumentBlobStore,
  identity: BrowserIdentity,
  workspaceId: string,
  input: HumanRevisionCommand,
  prepared: Awaited<ReturnType<typeof prepareHumanRevision>>,
) {
  const { sourceId, expectedId, reviewId, fingerprint } = prepared;
  const current = await workspaceAccess(client, identity, workspaceId, true, true);
  const currentReview = await revisionReview(client, current, reviewId);
  const replay = await priorHumanRevision(client, identity, input.requestKey, fingerprint);
  if (replay) return replay;
  if (
    prepared.alreadySaved ||
    current.currentVersionId !== expectedId ||
    currentReview.workspace_version_id !== sourceId
  )
    throw staleHumanRevision();
  const { encoded, sha256, difference, before, original, currentFile } = prepared;
  const blob = await store.put(encoded);
  if (blob.sha256 !== sha256)
    throw new AppError(500, 'WORKSPACE_CONTENT_MISMATCH', '修改稿写入后无法核对，请重试。');
  const level = highest(
    current.dataLevel,
    original.dataLevel,
    currentReview.data_level,
    input.dataLevel,
    ...[...before.values()].map(({ dataLevel }) => dataLevel),
  );
  const files = new Map(before);
  files.set(input.path, { ...currentFile, sha256, byteSize: encoded.length, dataLevel: level });
  await decisionAppend(store, before, files);
  const { version } = await installWorkspaceVersion(
    client,
    identity,
    current,
    files,
    '上传人工修改稿',
    level,
  );
  const {
    rows: [saved],
  } = await client.query<{ id: string }>(
    `INSERT INTO human_revision(workspace_id,review_id,source_version_id,new_version_id,
        author_id,browser_session_id,request_key,fingerprint,path,skill_id,skill_version,difference)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
      ON CONFLICT(author_id,request_key) DO NOTHING RETURNING id`,
    [
      current.id,
      reviewId,
      sourceId,
      version.id,
      identity.userId,
      identity.sessionId,
      input.requestKey,
      fingerprint,
      input.path,
      currentReview.skill_id,
      currentReview.skill_version,
      JSON.stringify(difference),
    ],
  );
  if (!saved) throw staleHumanRevision();
  await audit(
    client,
    identity,
    'workspace.human_revised',
    'workspace_version',
    version.id,
    { sourceId, sha256: original.sha256, reviewId },
    { versionId: version.id, sha256, revisionId: saved.id },
  );
  return humanRevisionViewSchema.parse({
    id: saved.id,
    reviewId,
    sourceVersionId: sourceId,
    path: input.path,
    version,
    skillId: currentReview.skill_id,
    skillVersion: currentReview.skill_version,
    difference,
  });
}

export async function saveDraft(
  pool: Executor,
  store: DocumentBlobStore,
  identity: ServiceIdentity,
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
  pool: Executor,
  store: DocumentBlobStore,
  identity: ServiceIdentity,
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

export async function resolveWorkspaceToolContext(
  client: PoolClient,
  identity: ServiceIdentity,
  projectId: string,
  conversationId: string,
  view: 'draft' | 'current' = 'draft',
  write = false,
) {
  const viewer = actor(identity);
  await activeActor(client, viewer);
  const located = (
    await client.query<{ workspace_id: string }>(
      `SELECT w.id AS workspace_id FROM conversation c JOIN workspace w ON w.project_id=c.project_id
     WHERE c.id=$1 AND c.user_id=$2 AND c.project_id=$3 AND c.status='active'`,
      [id(conversationId), viewer.userId, id(projectId)],
    )
  ).rows[0];
  if (!located) throw absent();
  const workspace = await workspaceAccess(client, viewer, located.workspace_id, write, write);
  const conversation = (
    await client.query<Conversation>(
      `SELECT id,project_id,user_id,permission_mode,status,max_data_level FROM conversation
     WHERE id=$1 AND user_id=$2${write ? ' FOR UPDATE' : ''}`,
      [conversationId, viewer.userId],
    )
  ).rows[0];
  if (!conversation || conversation.project_id !== workspace.projectId) throw absent();
  if (write) requireExecution(conversation);
  const found = (
    await client.query<Record<string, unknown>>(
      `SELECT ${draftFields} FROM workspace_draft d WHERE d.conversation_id=$1 AND d.owner_user_id=$2${write ? ' FOR UPDATE OF d' : ''}`,
      [conversationId, viewer.userId],
    )
  ).rows[0];
  const draft = found ? toDraft(found) : null;
  if (draft && (draft.workspaceId !== workspace.id || draft.projectId !== projectId))
    throw absent();
  if (write && !draft)
    throw new AppError(
      409,
      'WORKSPACE_DRAFT_REQUIRED',
      '当前对话尚未准备工作副本，请重新打开对话后再写入；不能指定其他对话的副本。',
    );
  const actualView = view === 'draft' && draft ? 'draft' : 'current';
  const files =
    actualView === 'draft' && draft
      ? await effectiveFiles(client, draft)
      : await manifest(client, workspace.currentVersionId);
  const level = highest(
    workspace.dataLevel,
    conversation.max_data_level,
    draft?.dataLevel,
    ...[...files.values()].map((file) => file.dataLevel),
  );
  const stateToken = digest({
    workspaceId: workspace.id,
    workspaceVersion: workspace.version,
    currentVersionId: workspace.currentVersionId,
    draftId: draft?.id ?? null,
    draftVersion: draft?.version ?? null,
    baseVersionId: draft?.baseVersionId ?? null,
    level,
    files: sorted(files),
    view: actualView,
  });
  return {
    workspace,
    draft,
    conversation,
    files,
    view: actualView,
    versionId: actualView === 'draft' && draft ? draft.baseVersionId : workspace.currentVersionId,
    dataLevel: level,
    stateToken,
  };
}

async function overlaySnapshot(client: PoolClient, draftId: string) {
  const result = await client.query<Record<string, unknown>>(
    `SELECT ${fileFields},is_deleted AS "isDeleted" FROM workspace_draft_file WHERE draft_id=$1 ORDER BY path COLLATE "C" LIMIT 10001`,
    [draftId],
  );
  if (result.rows.length > maxFiles)
    throw new AppError(413, 'WORKSPACE_FILE_LIMIT', '工作副本改动超过上限，不能捕获撤销快照。');
  return result.rows.map((row) =>
    workspaceUndoOverlaySchema.parse({
      ...row,
      byteSize: row.byteSize === null ? null : Number(row.byteSize),
    }),
  );
}

export async function workspaceVersionToken(
  client: PoolClient,
  identity: ServiceIdentity,
  draftId: string,
) {
  const context = await draftContext(client, actor(identity), id(draftId), true);
  return digest({
    workspaceId: context.workspace.id,
    currentVersionId: context.workspace.currentVersionId,
    workspaceVersion: context.workspace.version,
    workspaceLevel: context.workspace.dataLevel,
    draftId: context.draft.id,
    draftVersion: context.draft.version,
    baseVersionId: context.draft.baseVersionId,
    draftLevel: context.draft.dataLevel,
    overlay: await overlaySnapshot(client, draftId),
  });
}

async function verifiedContent(store: DocumentBlobStore, file: FileRecord) {
  const bytes = await store.get(file.sha256);
  if (
    bytes.byteLength !== file.byteSize ||
    createHash('sha256').update(bytes).digest('hex') !== file.sha256
  )
    throw new AppError(
      500,
      'WORKSPACE_CONTENT_MISMATCH',
      '文件内容与哈希记录不一致，已拒绝使用，请联系维护人员。',
    );
  return bytes;
}
export async function readWorkspaceToolText(store: DocumentBlobStore, file: FileRecord) {
  return decodeUtf8Text(await verifiedContent(store, file));
}

export async function captureWorkspaceUndo(
  client: PoolClient,
  store: DocumentBlobStore,
  identity: ServiceIdentity,
  draftId: string,
  publishes: boolean,
) {
  const context = await draftContext(client, actor(identity), id(draftId), true);
  const snapshot = workspaceUndoSnapshotSchema.parse({
    workspaceId: context.workspace.id,
    projectId: context.workspace.projectId,
    conversationId: context.conversation.id,
    ownerUserId: identity.userId,
    draftId,
    publicVersionId: context.workspace.currentVersionId,
    baseVersionId: context.draft.baseVersionId,
    overlay: await overlaySnapshot(client, draftId),
  });
  const bytes = Buffer.from(JSON.stringify(snapshot), 'utf8');
  const stored = await store.put(bytes);
  if (
    stored.sha256 !== createHash('sha256').update(bytes).digest('hex') ||
    stored.byteSize !== bytes.byteLength
  )
    throw new AppError(500, 'WORKSPACE_CONTENT_MISMATCH', '撤销快照保存校验失败，本次修改未开始。');
  return workspaceToolUndoStateSchema.parse({
    snapshotSha256: stored.sha256,
    byteSize: stored.byteSize,
    publishes,
  });
}

export async function advanceDraftConfirmation(
  client: PoolClient,
  identity: ServiceIdentity,
  draftId: string,
) {
  const viewer = actor(identity);
  const context = await draftContext(client, viewer, id(draftId), true);
  const changed = await client.query<Record<string, unknown>>(
    `UPDATE workspace_draft d SET version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING ${draftFields}`,
    [draftId],
  );
  const draft = toDraft(changed.rows[0]!);
  await audit(
    client,
    viewer,
    'workspace.rebase_confirmed',
    'workspace_draft',
    draftId,
    { version: context.draft.version },
    { version: draft.version },
  );
  return { draft };
}

export async function restoreWorkspaceUndo(
  client: PoolClient,
  store: DocumentBlobStore,
  identity: ServiceIdentity,
  draftId: string,
  input: WorkspaceToolUndoState,
) {
  const viewer = actor(identity);
  const state = workspaceToolUndoStateSchema.parse(input);
  const bytes = await store.get(state.snapshotSha256);
  if (
    bytes.byteLength !== state.byteSize ||
    createHash('sha256').update(bytes).digest('hex') !== state.snapshotSha256
  )
    throw new AppError(
      500,
      'WORKSPACE_UNDO_SNAPSHOT_INVALID',
      '撤销快照校验失败，当前工作区未改变。',
    );
  let raw: unknown;
  try {
    raw = JSON.parse(decodeUtf8Text(bytes));
  } catch {
    throw new AppError(
      500,
      'WORKSPACE_UNDO_SNAPSHOT_INVALID',
      '撤销快照不能读取，当前工作区未改变。',
    );
  }
  const parsed = workspaceUndoSnapshotSchema.safeParse(raw);
  if (!parsed.success)
    throw new AppError(
      500,
      'WORKSPACE_UNDO_SNAPSHOT_INVALID',
      '撤销快照格式无效，当前工作区未改变。',
    );
  const snapshot = parsed.data;
  const context = await draftContext(client, viewer, id(draftId), true);
  if (
    snapshot.draftId !== draftId ||
    snapshot.workspaceId !== context.workspace.id ||
    snapshot.projectId !== context.workspace.projectId ||
    snapshot.conversationId !== context.conversation.id ||
    snapshot.ownerUserId !== viewer.userId
  )
    throw absent();
  for (const versionId of [snapshot.baseVersionId, snapshot.publicVersionId]) {
    const accessible = await versionAccess(client, viewer, versionId);
    if (accessible.workspace.id !== context.workspace.id) throw absent();
  }
  const currentFiles = await effectiveFiles(client, context.draft);
  const latestDecision = currentFiles.get(decisionPath);
  let baseVersionId = snapshot.baseVersionId;
  let base = await manifest(client, baseVersionId);
  if (state.publishes) {
    await assertCurrentBase(client, context);
    const restored = await manifest(client, snapshot.publicVersionId);
    if (latestDecision) restored.set(decisionPath, latestDecision);
    await decisionAppend(store, currentFiles, restored);
    const saved = await persistVersion(
      client,
      viewer,
      context,
      restored,
      '撤销工作区操作，保留最新决定历史',
      'workspace.compensated',
    );
    baseVersionId = saved.version.id;
    base = restored;
  }
  const rows = new Map(snapshot.overlay.map((row) => [row.path, row]));
  if (
    latestDecision &&
    (rows.get(decisionPath)?.sha256 ?? base.get(decisionPath)?.sha256) !== latestDecision.sha256
  )
    rows.set(decisionPath, { ...latestDecision, isDeleted: false });
  const effective = new Map(base);
  for (const row of rows.values()) {
    if (row.isDeleted) effective.delete(row.path);
    else {
      const { isDeleted: _deleted, ...file } = row;
      effective.set(row.path, workspaceFileRecordSchema.parse(file));
    }
  }
  if (effective.size > maxFiles || rows.size > maxFiles)
    throw new AppError(
      413,
      'WORKSPACE_FILE_LIMIT',
      '撤销后的文件清单超过10000项，当前工作区未改变，请先核对差异。',
    );
  await decisionAppend(store, currentFiles, effective);
  const level = highest(
    context.workspace.dataLevel,
    context.draft.dataLevel,
    context.conversation.max_data_level,
    ...[...effective.values()].map((file) => file.dataLevel),
  );
  for (const file of effective.values()) await verifiedContent(store, file);
  await client.query('DELETE FROM workspace_draft_file WHERE draft_id=$1', [draftId]);
  if (rows.size)
    await client.query(
      `INSERT INTO workspace_draft_file(draft_id,path,sha256,byte_size,data_level,media_type,is_deleted)
     SELECT $1,r.path,r.sha256,r."byteSize",r."dataLevel"::document_data_level,r."mediaType",r."isDeleted"
     FROM jsonb_to_recordset($2::jsonb) AS r(path text,sha256 text,"byteSize" bigint,"dataLevel" text,"mediaType" text,"isDeleted" boolean)`,
      [
        draftId,
        JSON.stringify(
          [...rows.values()].map((row) => ({ ...row, dataLevel: highest(row.dataLevel, level) })),
        ),
      ],
    );
  await client.query(
    'UPDATE workspace_draft SET base_version_id=$1,data_level=GREATEST(data_level,$2::document_data_level),version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$3',
    [baseVersionId, level, draftId],
  );
  const latestWorkspace = await workspaceAccess(client, viewer, context.workspace.id, true, true);
  await raiseWorkspaceLevel(client, latestWorkspace, highest(latestWorkspace.dataLevel, level));
  await audit(
    client,
    viewer,
    'workspace.operation_undone',
    'workspace_draft',
    draftId,
    { draftVersion: context.draft.version, baseVersionId: context.draft.baseVersionId },
    { snapshotSha256: state.snapshotSha256, baseVersionId },
  );
  return { afterVersion: await workspaceVersionToken(client, viewer, draftId) };
}
