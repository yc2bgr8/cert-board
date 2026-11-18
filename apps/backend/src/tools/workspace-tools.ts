import { type ZodType } from 'zod';
import {
  workspaceToolListInputSchema,
  workspaceToolReadInputSchema,
  workspaceToolSearchInputSchema,
  workspaceToolWriteInputSchema,
  workspaceToolEditInputSchema,
  workspaceToolSaveInputSchema,
  workspaceToolRestoreInputSchema,
  workspaceToolListSchema,
  workspaceToolReadSchema,
  workspaceToolSearchSchema,
  workspaceToolWriteSchema,
  workspaceToolSaveSchema,
  workspaceToolRebaseSchema,
  workspaceToolUndoStateSchema,
  workspaceRebaseSchema,
  type DataLevel,
  type ToolMetadata,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import {
  resolveWorkspaceToolContext,
  listDraftFiles,
  listVersionFiles,
  readDraftFile,
  readVersionFile,
  writeDraftFile,
  saveDraft,
  restoreVersion,
  rebaseDraft,
  workspaceVersionToken,
  captureWorkspaceUndo,
  restoreWorkspaceUndo,
  readWorkspaceToolText,
  advanceDraftConfirmation,
} from '../workspace/service.js';
import type { ToolDefinition, ToolExecutionContext, ToolUndoSpec } from './registry.js';

type Scope = Awaited<ReturnType<typeof resolveWorkspaceToolContext>>;
const fail = (code: string, message: string, status = 409) => new AppError(status, code, message);
const highest = (...levels: DataLevel[]): 'internal' | 'confidential' =>
  levels.includes('confidential') ? 'confidential' : 'internal';
const views =
  'view为draft（本对话工作副本，默认）或current（项目已发布当前版本）；只读对话没有副本时自动读取current。';
const boundary =
  '只操作当前项目和本人对话；不能指定其他副本，也不访问宿主文件系统。决定记录.md由人的决定生成，通用工具不写改；撤销与恢复保留最新决定历史。';
async function scope(
  ctx: ToolExecutionContext,
  view: 'draft' | 'current' = 'draft',
  write = false,
) {
  if (!ctx.projectId)
    throw fail('WORKSPACE_PROJECT_REQUIRED', '请先进入项目对话，再读取或编辑工作区。', 400);
  return resolveWorkspaceToolContext(
    ctx.tx,
    ctx.actor,
    ctx.projectId,
    ctx.conversationId,
    view,
    write,
  );
}
function location(ctx: ToolExecutionContext, current: Scope) {
  const draft = current.view === 'draft' ? current.draft : null;
  return {
    workspaceId: current.workspace.id,
    projectId: current.workspace.projectId,
    view: current.view,
    versionId: current.versionId,
    currentVersionId: current.workspace.currentVersionId,
    draftId: draft?.id ?? null,
    draftVersion: draft?.version ?? null,
    stateToken: current.stateToken,
    dataLevel: highest(ctx.maxDataLevel, current.dataLevel),
  };
}
function protectedPath(path: string) {
  if (path === '决定记录.md')
    throw fail(
      'WORKSPACE_HUMAN_DECISIONS_ONLY',
      '决定记录属于只追加的人工作业历史，通用编辑不能保证撤销时不截断；请把候选判断写入交付报告和decisions[]并提交审核。',
      403,
    );
}
function boundedRead<
  T extends { text: string; offset: number; truncated: boolean; nextOffset: number | null },
>(result: T): T {
  if (JSON.stringify(result).length <= 32000) return result;
  const prefix = (length: number) => {
    let end = length;
    if (
      end > 0 &&
      end < result.text.length &&
      result.text.charCodeAt(end - 1) >= 0xd800 &&
      result.text.charCodeAt(end - 1) <= 0xdbff
    )
      end--;
    return {
      ...result,
      text: result.text.slice(0, end),
      truncated: true,
      nextOffset: result.offset + end,
    };
  };
  let low = 0,
    high = result.text.length,
    best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const value = prefix(mid);
    if (JSON.stringify(value).length <= 32000) {
      best = value.text.length;
      low = mid + 1;
    } else high = mid - 1;
  }
  if (!best)
    throw fail('WORKSPACE_OUTPUT_LIMIT', '文件定位信息超过输出上限，请联系维护人员核对。', 413);
  return prefix(best);
}
function boundedList<
  T extends { items: Array<{ path: string }>; hasMore: boolean; nextCursor: string | null },
>(value: T): T {
  const result = { ...value, items: [...value.items] };
  while (JSON.stringify(result).length > 32000 && result.items.length > 1) {
    result.items.pop();
    result.hasMore = true;
    result.nextCursor = result.items.at(-1)!.path;
  }
  if (JSON.stringify(result).length > 32000)
    throw fail('WORKSPACE_OUTPUT_LIMIT', '文件定位信息超过输出上限，请联系维护人员核对。', 413);
  return result;
}
function draftVersion(current: Scope, expected: number) {
  if (current.draft?.version !== expected)
    throw fail(
      'WORKSPACE_DRAFT_CONFLICT',
      '工作副本已有新修改，请重新ws_list读取draftVersion和文件哈希后再保存或恢复。',
    );
}
const defaultDescription = (
  purpose: string,
  whenToUse: string,
  avoid: string,
  parameters: string,
  example: ToolMetadata['description']['example'],
): ToolMetadata['description'] => ({ purpose, whenToUse, avoid, parameters, example });
function metadata(
  name: string,
  effect: 'read' | 'reversible_write',
  description: ToolMetadata['description'],
): ToolMetadata {
  return {
    name,
    version: 'builtin-workspace-v1',
    publication: 'published',
    effect,
    modes: effect === 'read' ? ['read_only', 'ask', 'full'] : ['ask', 'full'],
    approvalInAsk: false,
    outputDataLevel: 'dynamic',
    authorizationAction: effect === 'read' ? 'workspace.read' : 'workspace.write',
    description,
  };
}

export function buildWorkspaceTools(store: DocumentBlobStore): ToolDefinition[] {
  const refresh = async (ctx: ToolExecutionContext) =>
    highest(ctx.maxDataLevel, (await scope(ctx)).dataLevel);
  const read = (
    name: string,
    inputSchema: ZodType,
    outputSchema: ZodType,
    description: ToolMetadata['description'],
    execute: NonNullable<ToolDefinition['execute']>,
  ): ToolDefinition => ({
    metadata: metadata(name, 'read', description),
    inputSchema,
    outputSchema,
    execute,
    refreshDataLevel: refresh,
  });
  const undo = (publishes: boolean, pathInput = false): ToolUndoSpec => ({
    beforeSchema: workspaceToolUndoStateSchema,
    async capture(ctx, input) {
      const current = await scope(ctx, 'draft', true);
      if (pathInput && input && typeof input === 'object' && 'path' in input)
        protectedPath(String(input.path));
      if (input && typeof input === 'object' && 'expectedDraftVersion' in input)
        draftVersion(current, Number(input.expectedDraftVersion));
      const targetId = current.draft!.id;
      return {
        targetType: 'workspace_draft',
        targetId,
        beforeVersion: await workspaceVersionToken(ctx.tx, ctx.actor, targetId),
        beforeState: await captureWorkspaceUndo(ctx.tx, store, ctx.actor, targetId, publishes),
      };
    },
    async currentVersion(ctx, record) {
      const current = await scope(ctx, 'draft', true);
      if (record.targetType !== 'workspace_draft' || record.targetId !== current.draft!.id)
        throw fail('WORKSPACE_DRAFT_FORBIDDEN', '撤销凭据不属于本对话工作副本。', 403);
      return workspaceVersionToken(ctx.tx, ctx.actor, record.targetId);
    },
    async apply(ctx, record) {
      const current = await scope(ctx, 'draft', true);
      if (record.targetId !== current.draft!.id)
        throw fail('WORKSPACE_DRAFT_FORBIDDEN', '不能撤销其他对话的工作副本。', 403);
      return restoreWorkspaceUndo(
        ctx.tx,
        store,
        ctx.actor,
        record.targetId,
        workspaceToolUndoStateSchema.parse(record.beforeState),
      );
    },
  });
  const write = (
    name: string,
    inputSchema: ZodType,
    outputSchema: ZodType,
    description: ToolMetadata['description'],
    execute: NonNullable<ToolDefinition['execute']>,
    publishes = false,
    pathInput = false,
  ): ToolDefinition => ({
    metadata: metadata(name, 'reversible_write', description),
    inputSchema,
    outputSchema,
    execute,
    undo: undo(publishes, pathInput),
    refreshDataLevel: refresh,
  });

  return [
    read(
      'ws_list',
      workspaceToolListInputSchema,
      workspaceToolListSchema,
      defaultDescription(
        '列出当前项目的文件与哈希、工作副本版本及已发布版本。',
        '开始工作、确认保存基础或发生冲突后使用。',
        '正文用ws_read；资料库证据用doc_search/doc_read，工作区草稿不能作为V1来源。',
        `${views} cursor使用上次nextCursor，limit最多20；返回draftVersion供保存和恢复使用。${boundary}`,
        { view: 'draft', limit: 20 },
      ),
      async (ctx, input) => {
        const data = workspaceToolListInputSchema.parse(input),
          current = await scope(ctx, data.view);
        const paging = {
          limit: data.limit,
          ...(data.cursor === undefined ? {} : { cursor: data.cursor }),
        };
        const files =
          current.view === 'draft' && current.draft
            ? await listDraftFiles(ctx.tx, ctx.actor, current.draft.id, paging)
            : await listVersionFiles(ctx.tx, ctx.actor, current.versionId, paging);
        return {
          data: boundedList({ ...location(ctx, current), ...files }),
          dataLevel: highest(ctx.maxDataLevel, current.dataLevel),
        };
      },
    ),
    read(
      'ws_read',
      workspaceToolReadInputSchema,
      workspaceToolReadSchema,
      defaultDescription(
        '分页读取工作区UTF-8文本，返回路径、版本、当前文件哈希和继续位置。',
        '读取项目AGENTS.md、计划或需要编辑的原文；冲突时读取current与draft两侧。',
        '不是资料库原文；引用证据必须用doc_read。不能读取二进制或宿主路径。',
        `${views} path是NFC相对路径；offset用nextOffset，limit最多12000字符。`,
        { path: 'AGENTS.md', view: 'draft', limit: 8000 },
      ),
      async (ctx, input) => {
        const data = workspaceToolReadInputSchema.parse(input),
          current = await scope(ctx, data.view);
        const result =
          current.view === 'draft' && current.draft
            ? await readDraftFile(ctx.tx, store, ctx.actor, current.draft.id, data.path, {
                offset: data.offset,
                limit: data.limit,
              })
            : await readVersionFile(ctx.tx, store, ctx.actor, current.versionId, data.path, {
                offset: data.offset,
                limit: data.limit,
              });
        return {
          data: boundedRead({ ...result, ...location(ctx, current) }),
          dataLevel: highest(ctx.maxDataLevel, current.dataLevel, result.dataLevel),
        };
      },
    ),
    read(
      'ws_search',
      workspaceToolSearchInputSchema,
      workspaceToolSearchSchema,
      defaultDescription(
        '在工作区文本中作大小写敏感的字面检索，返回有界摘要和文件定位。',
        '文件较多时先定位内容，再ws_read读取完整上下文。',
        '不用正则，不搜索宿主；未命中不代表被跳过或尚未扫描文件中不存在内容。资料证据仍用doc_search。',
        `${views} query最多200字符；每页最多20文件、4MiB和20命中，每个摘要最多300字符。使用nextCursor续读，工作副本变化后重新开始。`,
        { query: 'K号', view: 'draft', limit: 10 },
      ),
      async (ctx, input) => {
        const data = workspaceToolSearchInputSchema.parse(input),
          current = await scope(ctx, data.view);
        if (data.cursor && data.cursor.stateToken !== current.stateToken)
          throw fail('WORKSPACE_SEARCH_STALE', '工作区已经变化，请不带cursor重新检索当前版本。');
        const files = [...current.files.values()].sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        );
        let index = data.cursor ? files.findIndex((file) => file.path === data.cursor!.path) : 0;
        if (index < 0)
          throw fail(
            'WORKSPACE_SEARCH_CURSOR',
            '搜索续读路径无效，请使用原返回的nextCursor或重新搜索。',
            400,
          );
        let offset = data.cursor?.offset ?? 0,
          scannedFiles = 0,
          scannedBytes = 0,
          skippedFiles = 0;
        let nextCursor: { stateToken: string; path: string; offset: number } | null = null;
        const items: Array<{
          path: string;
          sha256: string;
          matchOffset: number;
          snippet: string;
          dataLevel: 'internal' | 'confidential';
        }> = [];
        const cursor = (path: string, position: number) => ({
          stateToken: current.stateToken,
          path,
          offset: position,
        });
        let outputFull = false;
        for (; index < files.length; index++, offset = 0) {
          const file = files[index]!;
          if (
            scannedFiles >= 20 ||
            (file.byteSize <= 4 * 1024 * 1024 && scannedBytes + file.byteSize > 4 * 1024 * 1024)
          ) {
            nextCursor = cursor(file.path, offset);
            break;
          }
          scannedFiles++;
          if (!file.mediaType.startsWith('text/') || file.byteSize > 4 * 1024 * 1024) {
            skippedFiles++;
            continue;
          }
          const text = await readWorkspaceToolText(store, file);
          scannedBytes += file.byteSize;
          if (
            offset > text.length ||
            (offset < text.length &&
              text.charCodeAt(offset) >= 0xdc00 &&
              text.charCodeAt(offset) <= 0xdfff)
          )
            throw fail(
              'WORKSPACE_SEARCH_CURSOR',
              '续读位置不在完整字符边界，请使用nextCursor继续。',
              400,
            );
          let match = text.indexOf(data.query, offset);
          while (match >= 0) {
            let start = Math.max(0, match - 80);
            if (start > 0 && text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff)
              start++;
            let end = Math.min(text.length, start + 300);
            if (
              end < text.length &&
              text.charCodeAt(end - 1) >= 0xd800 &&
              text.charCodeAt(end - 1) <= 0xdbff
            )
              end--;
            const item = {
              path: file.path,
              sha256: file.sha256,
              matchOffset: match,
              snippet: text.slice(start, end),
              dataLevel: highest(ctx.maxDataLevel, current.dataLevel, file.dataLevel),
            };
            // 留出定位、游标和统计字段的空间；JSON转义不能让合法片段撑破工具32k上限。
            if (JSON.stringify([...items, item]).length > 28000) {
              nextCursor = cursor(file.path, match);
              outputFull = true;
              break;
            }
            items.push(item);
            const after = match + data.query.length;
            if (items.length === data.limit) {
              nextCursor =
                after < text.length
                  ? cursor(file.path, after)
                  : files[index + 1]
                    ? cursor(files[index + 1]!.path, 0)
                    : null;
              break;
            }
            match = text.indexOf(data.query, after);
          }
          if (items.length === data.limit || outputFull) break;
        }
        return {
          data: {
            ...location(ctx, current),
            items,
            scannedFiles,
            scannedBytes,
            skippedFiles,
            truncated: nextCursor !== null,
            nextCursor,
            warning: skippedFiles
              ? '本页跳过了非文本或超过4MiB的文件；没有命中不代表这些文件中不存在内容。'
              : null,
          },
          dataLevel: highest(ctx.maxDataLevel, current.dataLevel),
        };
      },
    ),
    write(
      'ws_write',
      workspaceToolWriteInputSchema,
      workspaceToolWriteSchema,
      defaultDescription(
        '按预期文件哈希写入本对话工作副本的UTF-8文本，不发布项目版本。',
        '起草中文Markdown或替换已完整读取的文件。',
        '局部改动优先ws_edit；最终保存用workspace_save。决定记录.md不能由通用编辑改写。',
        `path为相对路径；content最多100万字符。新文件可省略expectedSha256，默认为null。已有文件必须提供ws_read返回的哈希。${boundary}`,
        { path: '交付/核查记录.md', content: '# 核查记录\n\n待确认。', expectedSha256: null },
      ),
      async (ctx, input) => {
        const data = workspaceToolWriteInputSchema.parse(input);
        protectedPath(data.path);
        const current = await scope(ctx, 'draft', true);
        const result = await writeDraftFile(ctx.tx, store, ctx.actor, current.draft!.id, data);
        const token = await workspaceVersionToken(ctx.tx, ctx.actor, current.draft!.id);
        return {
          data: { ...result, stateToken: token },
          dataLevel: highest(ctx.maxDataLevel, result.draft.dataLevel),
          afterVersion: token,
        };
      },
      false,
      true,
    ),
    write(
      'ws_edit',
      workspaceToolEditInputSchema,
      workspaceToolWriteSchema,
      defaultDescription(
        '用完整原文片段作一次精确替换，只改当前工作副本。',
        '已经ws_read核对文件哈希，需要修改一处内容时。',
        '不使用正则，不默默替换多处；全文起草用ws_write，决定记录.md不允许此工具修改。',
        `path、expectedSha256来自读取回执；oldText非空且必须唯一出现，newText可空。片段各最多64000字符。${boundary}`,
        {
          path: '交付/核查记录.md',
          expectedSha256: '0'.repeat(64),
          oldText: '待确认。',
          newText: '两处写法不同，待原件核对。',
        },
      ),
      async (ctx, input) => {
        const data = workspaceToolEditInputSchema.parse(input);
        protectedPath(data.path);
        const current = await scope(ctx, 'draft', true),
          file = current.files.get(data.path);
        if (!file || file.sha256 !== data.expectedSha256)
          throw fail(
            'WORKSPACE_FILE_CONFLICT',
            '文件哈希已改变或文件不存在，请先ws_read当前文件再编辑。',
          );
        const text = await readWorkspaceToolText(store, file),
          found = text.indexOf(data.oldText);
        if (found < 0 || text.indexOf(data.oldText, found + 1) >= 0)
          throw fail(
            'WORKSPACE_EDIT_AMBIGUOUS',
            '原文片段未找到或不唯一，请读取更多上下文并提供唯一片段。',
          );
        const result = await writeDraftFile(ctx.tx, store, ctx.actor, current.draft!.id, {
          path: data.path,
          expectedSha256: data.expectedSha256,
          content: text.slice(0, found) + data.newText + text.slice(found + data.oldText.length),
        });
        const token = await workspaceVersionToken(ctx.tx, ctx.actor, current.draft!.id);
        return {
          data: { ...result, stateToken: token },
          dataLevel: highest(ctx.maxDataLevel, result.draft.dataLevel),
          afterVersion: token,
        };
      },
      false,
      true,
    ),
    write(
      'workspace_save',
      workspaceToolSaveInputSchema,
      workspaceToolSaveSchema,
      defaultDescription(
        '将本对话工作副本保存为项目新版本，返回可提交审核的workspaceVersion。',
        '报告已完成且本副本基于项目当前版本时。',
        '不冻结定稿；遇冲突先ws_read两侧并workspace_rebase，不能覆盖他人保存。',
        'summary说明这次改动；expectedDraftVersion用ws_list或写入返回的draft.version。撤销通过新增补偿版本，保留决定历史。',
        { summary: '保存K号文字核查报告', expectedDraftVersion: 2 },
      ),
      async (ctx, input) => {
        const data = workspaceToolSaveInputSchema.parse(input),
          current = await scope(ctx, 'draft', true);
        draftVersion(current, data.expectedDraftVersion);
        const result = await saveDraft(ctx.tx, store, ctx.actor, current.draft!.id, data.summary),
          token = await workspaceVersionToken(ctx.tx, ctx.actor, current.draft!.id);
        return {
          data: { ...result, workspaceVersion: result.version.id, stateToken: token },
          dataLevel: highest(ctx.maxDataLevel, result.version.dataLevel),
          afterVersion: token,
        };
      },
      true,
    ),
    write(
      'workspace_restore',
      workspaceToolRestoreInputSchema,
      workspaceToolSaveSchema,
      defaultDescription(
        '把本项目某个已发布旧版本的普通文件恢复为新版本，保留最新决定记录。',
        '已核对差异并明确要恢复旧内容时。',
        '不是删除历史或回退指针，也不能恢复其他项目或未发布版本。',
        'targetVersionId是本项目已发布版本UUID；expectedDraftVersion用当前副本版本，summary说明恢复原因。撤销也追加补偿新版本。',
        {
          targetVersionId: '10000000-0000-4000-8000-000000000001',
          expectedDraftVersion: 2,
          summary: '恢复上一版正文，保留决定历史',
        },
      ),
      async (ctx, input) => {
        const data = workspaceToolRestoreInputSchema.parse(input),
          current = await scope(ctx, 'draft', true);
        draftVersion(current, data.expectedDraftVersion);
        const result = await restoreVersion(
            ctx.tx,
            store,
            ctx.actor,
            current.draft!.id,
            data.targetVersionId,
            data.summary,
          ),
          token = await workspaceVersionToken(ctx.tx, ctx.actor, current.draft!.id);
        return {
          data: { ...result, workspaceVersion: result.version.id, stateToken: token },
          dataLevel: highest(ctx.maxDataLevel, result.version.dataLevel),
          afterVersion: token,
        };
      },
      true,
    ),
    write(
      'workspace_rebase',
      workspaceRebaseSchema,
      workspaceToolRebaseSchema,
      defaultDescription(
        '显式将本副本合并到项目最新版本，保留本副本改动，解决保存基础版本冲突。',
        'workspace_save返回冲突后，先用ws_read的draft/current读取双方内容。',
        '不会自动合并同路径正文，不支持force；决定记录分叉请从最新版本新建对话逐条补录。',
        'expectedDraftVersion和expectedCurrentVersionId来自ws_list。无重叠可resolutions=[]；重叠路径须先编辑合并内容，再逐路径确认current和draft实际sha。确认无改动也推进副本版本便于撤销幂等。',
        {
          expectedDraftVersion: 2,
          expectedCurrentVersionId: '10000000-0000-4000-8000-000000000001',
          resolutions: [],
        },
      ),
      async (ctx, input, before) => {
        const data = workspaceRebaseSchema.parse(input),
          current = await scope(ctx, 'draft', true);
        let result = await rebaseDraft(ctx.tx, store, ctx.actor, current.draft!.id, data);
        let token = await workspaceVersionToken(ctx.tx, ctx.actor, current.draft!.id);
        if (token === before?.beforeVersion) {
          result = await advanceDraftConfirmation(ctx.tx, ctx.actor, current.draft!.id);
          token = await workspaceVersionToken(ctx.tx, ctx.actor, current.draft!.id);
        }
        return {
          data: {
            ...result,
            currentVersionId: current.workspace.currentVersionId,
            stateToken: token,
          },
          dataLevel: highest(ctx.maxDataLevel, result.draft.dataLevel),
          afterVersion: token,
        };
      },
    ),
  ];
}
