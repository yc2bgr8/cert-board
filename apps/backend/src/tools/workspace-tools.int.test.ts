import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  agentIdentitySchema,
  codeRunOutputSchema,
  workspaceToolListSchema,
  workspaceToolReadSchema,
  workspaceToolWriteSchema,
  workspaceToolSaveSchema,
  workspaceToolRebaseSchema,
  workspaceToolSearchSchema,
  type PermissionMode,
} from '@cert-board/shared';
import { createIntegrationContext, type MemberKey } from '../test-support/context.js';
import { seedDevelopmentWorkspace } from '../workspace/seed.js';
import { createDraft, getDraft } from '../workspace/service.js';
import { createToolRuntime } from '../agent/tool-runtime.js';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import { buildWorkspaceTools } from './workspace-tools.js';
import { ToolRegistry } from './registry.js';
import { buildSandboxTools } from './code-run.js';
import { SandboxClient } from '../sandbox/client.js';

class MemoryStore implements DocumentBlobStore {
  readonly contents = new Map<string, Buffer>();
  async put(content: Buffer) {
    const sha256 = createHash('sha256').update(content).digest('hex');
    this.contents.set(sha256, Buffer.from(content));
    return { sha256, byteSize: content.byteLength };
  }
  async get(sha: string) {
    const content = this.contents.get(sha);
    if (!content) throw new Error('测试对象不存在');
    return Buffer.from(content);
  }
}
let context: Awaited<ReturnType<typeof createIntegrationContext>>;
let store: MemoryStore;
let registry: ToolRegistry;
let owner: Awaited<ReturnType<typeof prepare>>;
async function prepare(member: MemberKey = 'MEMBER_A', permissionMode: PermissionMode = 'ask') {
  const run = await context.run(member, permissionMode);
  const actor = agentIdentitySchema.parse({
    kind: 'agent',
    runId: run.runId,
    userId: run.userId,
    username: member === 'MEMBER_B' ? 'wangmin' : 'zhangsan',
    displayName: '测试成员',
    isDevelopment: true,
    isManagement: false,
  });
  const draft =
    permissionMode === 'read_only'
      ? null
      : await createDraft(context.pool, actor, run.conversationId);
  return { ...run, actor, draft };
}
const reference = (who = owner, callId: string = randomUUID()) => ({
  runId: who.runId,
  userId: who.userId,
  callId,
});
const call = (name: string, input: unknown, who = owner, callId?: string) =>
  registry.execute(reference(who, callId), name, input);
async function list(who = owner, view: 'draft' | 'current' = 'draft') {
  return workspaceToolListSchema.parse((await call('ws_list', { view }, who)).data);
}
async function read(path: string, who = owner, view: 'draft' | 'current' = 'draft') {
  return workspaceToolReadSchema.parse((await call('ws_read', { path, view }, who)).data);
}
async function write(
  path: string,
  content: string,
  expectedSha256: string | null = null,
  who = owner,
) {
  const result = await call('ws_write', { path, content, expectedSha256 }, who);
  return { ...result, value: workspaceToolWriteSchema.parse(result.data) };
}
async function save(who = owner) {
  const state = await list(who);
  const result = await call(
    'workspace_save',
    { summary: '保存中文核查报告', expectedDraftVersion: state.draftVersion },
    who,
  );
  return { ...result, value: workspaceToolSaveSchema.parse(result.data) };
}
beforeEach(async () => {
  context = await createIntegrationContext();
  store = new MemoryStore();
  await seedDevelopmentWorkspace(context.pool, store, { NODE_ENV: 'test' });
  owner = await prepare();
  registry = new ToolRegistry(context.pool, buildWorkspaceTools(store));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await context?.close();
});

test('沙箱只读运行允许预览，保存产出进入工作副本并可撤销', async () => {
  const data = Buffer.from('synthetic binary fixture');
  const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
  const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
    const input = JSON.parse(String(init?.body)) as {
      code: string;
      files: { name: string; bodyBase64: string }[];
    };
    return Response.json({
      status: 'ok',
      exitCode: 0,
      elapsedMs: 12,
      codeSha256: hash(input.code),
      inputHashes: input.files.map((file) => ({
        name: file.name,
        sha256: hash(Buffer.from(file.bodyBase64, 'base64')),
      })),
      stdout: '样例',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      files: [
        {
          path: '报告.pdf',
          sha256: hash(data),
          byteSize: data.length,
          bodyBase64: data.toString('base64'),
        },
      ],
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  const combined = new ToolRegistry(context.pool, [
    ...buildWorkspaceTools(store),
    ...buildSandboxTools(store, new SandboxClient('http://127.0.0.1:28083', 'host')),
  ]);
  const readonly = await prepare('MEMBER_A', 'read_only');
  const code = 'print("fictional")';
  const inputs = [{ source: 'workspace', path: 'AGENTS.md', view: 'current', name: 'notes.md' }];
  const preview = codeRunOutputSchema.parse(
    (await combined.execute(reference(readonly), 'code_run', { code, inputs })).data,
  );
  expect(preview.files).toEqual([expect.objectContaining({ path: '报告.pdf' })]);
  const draft = owner.draft!;
  const request = {
    code,
    inputs,
    outputDirectory: '交付/代码产出',
    expectedDraftVersion: draft.version,
  };
  await expect(
    combined.execute(reference(readonly), 'code_run_save', request),
  ).rejects.toMatchObject({ statusCode: 403 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const saved = await combined.execute(reference(), 'code_run_save', request);
  expect(saved.undoId).toEqual(expect.any(String));
  const output = codeRunOutputSchema.parse(saved.data);
  expect(output.outputDirectory).toBe('交付/代码产出');
  const stored = await context.pool.query(
    'SELECT sha256,media_type FROM workspace_draft_file WHERE draft_id=$1 AND path=$2 AND NOT is_deleted',
    [draft.id, '交付/代码产出/报告.pdf'],
  );
  expect(stored.rows).toEqual([{ sha256: hash(data), media_type: 'application/pdf' }]);
  expect(await store.get(stored.rows[0].sha256)).toEqual(data);
  const currentDraft = await list();
  const duplicate = await combined.execute(reference(), 'code_run_save', {
    ...request,
    expectedDraftVersion: currentDraft.draftVersion,
  });
  expect(duplicate.undoId).toBeNull();
  expect(duplicate.data).toMatchObject({ saveStatus: 'skipped', saveError: 'PATH_UNAVAILABLE' });
  expect((await list()).draftVersion).toBe(currentDraft.draftVersion);
  await combined.undo(reference(), saved.undoId!);
  expect((await list()).items.some((entry) => entry.path === '交付/代码产出/报告.pdf')).toBe(false);

  const largePaths = Array.from(
    { length: 32 },
    (_, index) => `${'a'.repeat(160)}/${'b'.repeat(160)}/${'c'.repeat(160)}/${index}.pdf`,
  );
  fetchMock.mockImplementationOnce(async (_url, init) => {
    const script = JSON.parse(String(init?.body)).code as string;
    return Response.json({
      status: 'ok',
      exitCode: 0,
      elapsedMs: 1,
      codeSha256: hash(script),
      inputHashes: [],
      stdout: '\u001b'.repeat(2500),
      stderr: '\u001b'.repeat(2500),
      stdoutTruncated: false,
      stderrTruncated: false,
      files: largePaths.map((path) => ({
        path,
        sha256: hash(data),
        byteSize: data.length,
        bodyBase64: data.toString('base64'),
      })),
    });
  });
  const manifest = codeRunOutputSchema.parse(
    (await combined.execute(reference(readonly), 'code_run', { code })).data,
  );
  expect(manifest.files.map((file) => file.path)).toEqual(largePaths);
  expect(manifest.stdoutTruncated).toBe(true);
});

test('真实登记工具读取、写中文Markdown、精确编辑和保存返回可审核版本', async () => {
  expect((await read('AGENTS.md')).text).toContain('L08 510(k)');
  const first = await write('交付/K号核查.md', '# 核查记录\n初稿：待确认。\n');
  await expect(read('交付/K号核查.md', owner, 'current')).rejects.toMatchObject({
    statusCode: 404,
  });
  const edited = workspaceToolWriteSchema.parse(
    (
      await call('ws_edit', {
        path: '交付/K号核查.md',
        expectedSha256: first.value.file.sha256,
        oldText: '初稿：待确认。',
        newText: '两处K号写法不同，请注册人员核对原件。',
      })
    ).data,
  );
  const saved = workspaceToolSaveSchema.parse(
    (
      await call('workspace_save', {
        summary: '保存两处原文差异',
        expectedDraftVersion: edited.draft.version,
      })
    ).data,
  );
  expect(saved.workspaceVersion).toBe(saved.version.id);
  expect(saved.version.number).toBe(2);
  expect((await read('交付/K号核查.md', owner, 'current')).text).toContain('注册人员核对原件');
  expect(saved.draft.baseVersionId).toBe(saved.workspaceVersion);
  const audit = await context.pool.query(
    "SELECT before_hash,after_hash FROM audit_log WHERE action='workspace.saved'",
  );
  expect(audit.rowCount).toBe(1);
  expect(JSON.stringify(audit.rows).includes('注册人员')).toBe(false);
});

test('同call并发只生效一次，文件旧hash和副本旧version仍拒绝', async () => {
  const id = randomUUID(),
    input = { path: '草稿/一次.md', content: '一次' };
  const results = await Promise.all([
    call('ws_write', input, owner, id),
    call('ws_write', input, owner, id),
  ]);
  expect(results.filter((result) => result.replayed)).toHaveLength(1);
  const first = workspaceToolWriteSchema.parse(results[0]!.data);
  expect(first.draft.version).toBe(2);
  await expect(
    call('ws_write', { ...input, expectedSha256: null }, owner, id),
  ).rejects.toMatchObject({
    code: 'TOOL_IDEMPOTENCY_CONFLICT',
  });
  await expect(
    call('ws_write', { ...input, content: '不应覆盖' }, owner, id),
  ).rejects.toMatchObject({ code: 'TOOL_IDEMPOTENCY_CONFLICT' });
  await expect(
    call('ws_write', { ...input, content: '无哈希时不能覆盖已有文件' }),
  ).rejects.toMatchObject({ statusCode: 409 });
  await expect(write(input.path, '旧哈希写入', '0'.repeat(64))).rejects.toMatchObject({
    statusCode: 409,
  });
  await expect(
    call('workspace_save', { summary: '旧版本', expectedDraftVersion: 1 }),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect((await read(input.path)).text).toBe('一次');
});

test('编辑要求唯一字面片段，重复匹配和缺失不改变内容', async () => {
  const first = await write('草稿/编辑.md', '同文 同文 A+B[0]');
  for (const oldText of ['同文', '不存在'])
    await expect(
      call('ws_edit', {
        path: first.value.file.path,
        expectedSha256: first.value.file.sha256,
        oldText,
        newText: '不能写',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  const edited = workspaceToolWriteSchema.parse(
    (
      await call('ws_edit', {
        path: first.value.file.path,
        expectedSha256: first.value.file.sha256,
        oldText: 'A+B[0]',
        newText: '中文😀',
      })
    ).data,
  );
  expect(edited.draft.version).toBe(first.value.draft.version + 1);
  expect((await read(first.value.file.path)).text).toBe('同文 同文 中文😀');
});

test('同基础版本保存冲突可显式重基，保留双方不同路径再保存', async () => {
  const colleague = await prepare('MEMBER_B');
  await write('交付/甲.md', '甲的原文');
  await write('交付/乙.md', '乙的原文', null, colleague);
  const first = await save();
  await expect(save(colleague)).rejects.toMatchObject({ statusCode: 409 });
  const pending = await list(colleague);
  const rebased = workspaceToolRebaseSchema.parse(
    (
      await call(
        'workspace_rebase',
        {
          expectedDraftVersion: pending.draftVersion,
          expectedCurrentVersionId: first.value.workspaceVersion,
          resolutions: [],
        },
        colleague,
      )
    ).data,
  );
  expect(rebased.draft.baseVersionId).toBe(first.value.workspaceVersion);
  const second = await save(colleague);
  expect(second.value.version.number).toBe(3);
  expect((await read('交付/甲.md', colleague, 'current')).text).toBe('甲的原文');
  expect((await read('交付/乙.md', owner, 'current')).text).toBe('乙的原文');
});

test('同一路径冲突要读取两侧并手动合并，旧确认不能覆盖另一方', async () => {
  const second = await prepare();
  await write('交付/合并.md', '甲记录');
  await write('交付/合并.md', '乙记录', null, second);
  const published = await save();
  const pending = await list(second);
  await expect(
    call(
      'workspace_rebase',
      {
        expectedDraftVersion: pending.draftVersion,
        expectedCurrentVersionId: published.value.workspaceVersion,
        resolutions: [],
      },
      second,
    ),
  ).rejects.toMatchObject({ statusCode: 409 });
  const current = await read('交付/合并.md', second, 'current'),
    draft = await read('交付/合并.md', second);
  const merged = await write(
    '交付/合并.md',
    current.text + '\n' + draft.text,
    draft.sha256,
    second,
  );
  const resolution = {
    path: '交付/合并.md',
    expectedCurrentSha256: current.sha256,
    expectedDraftSha256: merged.value.file.sha256,
  };
  await expect(
    call(
      'workspace_rebase',
      {
        expectedDraftVersion: merged.value.draft.version,
        expectedCurrentVersionId: published.value.workspaceVersion,
        resolutions: [{ ...resolution, expectedCurrentSha256: '0'.repeat(64) }],
      },
      second,
    ),
  ).rejects.toMatchObject({ statusCode: 409 });
  await call(
    'workspace_rebase',
    {
      expectedDraftVersion: merged.value.draft.version,
      expectedCurrentVersionId: published.value.workspaceVersion,
      resolutions: [resolution],
    },
    second,
  );
  await save(second);
  expect((await read('交付/合并.md', owner, 'current')).text).toBe('甲记录\n乙记录');
});

test('没有改变的重基仍给真实递增版本，可撤销且不伪造after token', async () => {
  const initial = await list();
  const result = await call('workspace_rebase', {
    expectedDraftVersion: initial.draftVersion,
    expectedCurrentVersionId: initial.currentVersionId,
    resolutions: [],
  });
  expect(workspaceToolRebaseSchema.parse(result.data).draft.version).toBe(
    initial.draftVersion! + 1,
  );
  await registry.undo(reference(), result.undoId!);
  expect((await list()).draftVersion).toBe(initial.draftVersion! + 2);
});

test('新工具实例能用持久快照撤销新建或已有overlay，重复撤销不重做', async () => {
  const added = await write('草稿/新建.md', '新内容');
  registry = new ToolRegistry(context.pool, buildWorkspaceTools(store));
  const ref = reference();
  await registry.undo(ref, added.undoId!);
  const version = (await list()).draftVersion;
  await registry.undo(ref, added.undoId!);
  expect((await list()).draftVersion).toBe(version);
  await expect(read('草稿/新建.md')).rejects.toMatchObject({ statusCode: 404 });
  const first = await write('草稿/修改.md', '第一版');
  const second = await write('草稿/修改.md', '第二版', first.value.file.sha256);
  await registry.undo(reference(), second.undoId!);
  expect((await read('草稿/修改.md')).text).toBe('第一版');
  const snapshot = (
    await context.pool.query('SELECT before_state FROM undo_record WHERE id=$1', [second.undoId])
  ).rows[0].before_state;
  expect(Object.keys(snapshot).sort()).toEqual(['byteSize', 'publishes', 'snapshotSha256']);
  expect(JSON.stringify(snapshot).includes('第一版')).toBe(false);
});

test('后续私有编辑使旧撤销过期，不能抹去后来改动', async () => {
  const first = await write('草稿/先.md', '先');
  await write('草稿/后.md', '后');
  await expect(registry.undo(reference(), first.undoId!)).rejects.toMatchObject({
    code: 'TOOL_UNDO_CONFLICT',
  });
  expect((await read('草稿/先.md')).text).toBe('先');
  expect((await read('草稿/后.md')).text).toBe('后');
});

test('保存撤销追加补偿新版本并恢复私有overlay，旧版与冻结快照不改', async () => {
  await write('交付/撤销保存.md', '保留的工作副本');
  const saved = await save();
  const manifest = (
    await context.pool.query(
      'SELECT path,sha256 FROM workspace_file WHERE version_id=$1 ORDER BY path',
      [saved.value.workspaceVersion],
    )
  ).rows;
  const snapshot = (
    await context.pool.query<{ id: string }>(
      "INSERT INTO submission_snapshot(project_id,sequence,kind,file_manifest,manifest_sha256,workspace_version_id,created_by) VALUES($1,1,'approved_review',$2,$3,$4,$5) RETURNING id",
      [
        context.projectId,
        JSON.stringify(manifest),
        createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
        saved.value.workspaceVersion,
        owner.userId,
      ],
    )
  ).rows[0]!.id;
  await registry.undo(reference(), saved.undoId!);
  const current = await list();
  expect(current.currentVersionId).not.toBe(saved.value.workspaceVersion);
  expect(
    (
      await context.pool.query('SELECT number FROM workspace_version WHERE id=$1', [
        current.currentVersionId,
      ])
    ).rows[0].number,
  ).toBe(3);
  await expect(read('交付/撤销保存.md', owner, 'current')).rejects.toMatchObject({
    statusCode: 404,
  });
  expect((await read('交付/撤销保存.md')).text).toBe('保留的工作副本');
  expect(
    (
      await context.pool.query('SELECT file_manifest FROM submission_snapshot WHERE id=$1', [
        snapshot,
      ])
    ).rows[0].file_manifest,
  ).toEqual(manifest);
  expect(
    (
      await context.pool.query('SELECT path FROM workspace_file WHERE version_id=$1 AND path=$2', [
        saved.value.workspaceVersion,
        '交付/撤销保存.md',
      ])
    ).rowCount,
  ).toBe(1);
});

test('恢复和撤销恢复均新增版本，另一对话保存后不能撤销旧保存', async () => {
  await write('交付/版本.md', '版本甲');
  const first = await save();
  const file = await read('交付/版本.md');
  await write(file.path, '版本乙', file.sha256);
  const second = await save();
  const state = await list();
  const restored = await call('workspace_restore', {
    targetVersionId: first.value.workspaceVersion,
    summary: '恢复甲内容',
    expectedDraftVersion: state.draftVersion,
  });
  expect((await read(file.path, owner, 'current')).text).toBe('版本甲');
  await registry.undo(reference(), restored.undoId!);
  expect((await read(file.path, owner, 'current')).text).toBe('版本乙');
  const other = await prepare('MEMBER_B');
  await write('交付/他人.md', '他人', null, other);
  await save(other);
  await expect(registry.undo(reference(), second.undoId!)).rejects.toMatchObject({
    code: 'TOOL_UNDO_CONFLICT',
  });
  expect((await read('交付/他人.md', owner, 'current')).text).toBe('他人');
});

test('工具只绑定当前对话，私有副本互不可读，只读没有写目录且不创建副本', async () => {
  await write('草稿/私有.md', '仅本对话');
  const sameUser = await prepare();
  await expect(read('草稿/私有.md', sameUser)).rejects.toMatchObject({ statusCode: 404 });
  await expect(call('ws_list', { draftId: owner.draft!.id }, sameUser)).rejects.toMatchObject({
    code: 'TOOL_INPUT_INVALID',
  });
  const readonly = await prepare('MEMBER_B', 'read_only');
  const catalog = await registry.catalog({ runId: readonly.runId, userId: readonly.userId });
  expect(catalog.map((item) => item.name)).toEqual(['ws_list', 'ws_read', 'ws_search']);
  const listed = await list(readonly);
  expect(listed.view).toBe('current');
  expect(listed.draftId).toBeNull();
  await expect(write('草稿/只读.md', '不能写', null, readonly)).rejects.toMatchObject({
    code: 'TOOL_READ_ONLY',
  });
  expect(
    (
      await context.pool.query('SELECT id FROM workspace_draft WHERE conversation_id=$1', [
        readonly.conversationId,
      ])
    ).rowCount,
  ).toBe(0);
});

test('决定记录拒通用改写，保存恢复和撤销都不截断已有历史', async () => {
  const before = await read('决定记录.md');
  await expect(
    write(before.path, before.text + '\n不可冒充人的决定。', before.sha256),
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    call('ws_edit', {
      path: before.path,
      expectedSha256: before.sha256,
      oldText: before.text,
      newText: '',
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
  const written = await write('交付/普通.md', '普通正文');
  await registry.undo(reference(), written.undoId!);
  expect((await read(before.path)).text).toBe(before.text);
  const history = before.text + '\n人工确认的测试历史，撤销文件保存不能删除。\n';
  const blob = await store.put(Buffer.from(history));
  await context.pool.query(
    "INSERT INTO workspace_draft_file(draft_id,path,sha256,byte_size,data_level,media_type,is_deleted) VALUES($1,'决定记录.md',$2,$3,'internal','text/markdown',false)",
    [owner.draft!.id, blob.sha256, blob.byteSize],
  );
  await context.pool.query('UPDATE workspace_draft SET version=version+1 WHERE id=$1', [
    owner.draft!.id,
  ]);
  const saved = await save();
  await registry.undo(reference(), saved.undoId!);
  expect((await read(before.path, owner, 'current')).text).toBe(history);
  expect((await read(before.path)).text).toBe(history);
});

test('撤销文本编辑保留原有二进制文件引用，不把二进制当文本解析', async () => {
  const blob = await store.put(Buffer.from([0xff, 0x00, 0xab, 0x12]));
  await context.pool.query(
    "INSERT INTO workspace_draft_file(draft_id,path,sha256,byte_size,data_level,media_type,is_deleted) VALUES($1,'资料/原件.bin',$2,$3,'internal','application/octet-stream',false)",
    [owner.draft!.id, blob.sha256, blob.byteSize],
  );
  await context.pool.query('UPDATE workspace_draft SET version=version+1 WHERE id=$1', [
    owner.draft!.id,
  ]);
  const changed = await write('交付/文字.md', '文字内容');
  await registry.undo(reference(), changed.undoId!);
  const files = await list();
  expect(files.items.find((file) => file.path === '资料/原件.bin')?.sha256).toBe(blob.sha256);
  await expect(read('交付/文字.md')).rejects.toMatchObject({ statusCode: 404 });
});

test('事务持有者在写入后收到停止，业务和撤销记录整体回滚', async () => {
  const controller = new AbortController();
  const definitions = buildWorkspaceTools(store).map((definition) =>
    definition.metadata.name === 'ws_write'
      ? {
          ...definition,
          async execute(...args: Parameters<NonNullable<typeof definition.execute>>) {
            const result = await definition.execute!(...args);
            controller.abort();
            return result;
          },
        }
      : definition,
  );
  const runtime = await createToolRuntime({
    pool: context.pool,
    definitions,
    runId: owner.runId,
    userId: owner.userId,
    ownerId: randomUUID(),
    signal: controller.signal,
    environment: 'test',
  });
  const ref = reference();
  await expect(
    runtime.registry.execute(ref, 'ws_write', {
      path: '交付/回滚.md',
      content: '不应提交',
      expectedSha256: null,
    }),
  ).rejects.toMatchObject({ code: 'TOOL_RUNTIME_INACTIVE' });
  await expect(read('交付/回滚.md')).rejects.toMatchObject({ statusCode: 404 });
  expect(
    (
      await context.pool.query('SELECT id FROM tool_invocation WHERE run_id=$1 AND call_id=$2', [
        ref.runId,
        ref.callId,
      ])
    ).rowCount,
  ).toBe(0);
  expect(
    (await context.pool.query('SELECT id FROM undo_record WHERE run_id=$1', [owner.runId]))
      .rowCount,
  ).toBe(0);
  expect(
    (
      await context.pool.query(
        "SELECT id FROM audit_log WHERE action='workspace.file_written' AND target_id=$1",
        [owner.draft!.id],
      )
    ).rowCount,
  ).toBe(0);
});

test('搜索有界续读，副本改变后旧游标拒绝，Unicode读取不拆字符', async () => {
  await write('草稿/检索.md', '甲😀 K123456\n'.repeat(100));
  const first = workspaceToolSearchSchema.parse(
    (await call('ws_search', { query: 'K123456', limit: 1 })).data,
  );
  expect(first.items).toHaveLength(1);
  expect(first.truncated).toBe(true);
  expect(first.items[0]!.snippet.length <= 300).toBe(true);
  const second = workspaceToolSearchSchema.parse(
    (await call('ws_search', { query: 'K123456', limit: 1, cursor: first.nextCursor })).data,
  );
  expect(second.items[0]!.matchOffset).toBeGreaterThan(first.items[0]!.matchOffset);
  await write('草稿/新文件.md', '新文件');
  await expect(
    call('ws_search', { query: 'K123456', cursor: first.nextCursor }),
  ).rejects.toMatchObject({ statusCode: 409 });
  const piece = workspaceToolReadSchema.parse(
    (await call('ws_read', { path: '草稿/检索.md', limit: 2 })).data,
  );
  expect(piece.text).toBe('甲');
  expect(piece.nextOffset).toBe(1);
  await expect(call('ws_read', { path: '../机密' })).rejects.toMatchObject({
    code: 'TOOL_INPUT_INVALID',
  });
});

test('读取回执重放与撤销均继承当前最高级别，不使用旧快照降级', async () => {
  const ref = reference();
  const readResult = await registry.execute(ref, 'ws_read', { path: 'AGENTS.md' });
  expect(readResult.dataLevel).toBe('internal');
  const written = await write('草稿/分级.md', '分级正文');
  await context.pool.query("UPDATE conversation SET max_data_level='confidential' WHERE id=$1", [
    owner.conversationId,
  ]);
  expect((await registry.execute(ref, 'ws_read', { path: 'AGENTS.md' })).dataLevel).toBe(
    'confidential',
  );
  await registry.undo(reference(), written.undoId!);
  expect((await getDraft(context.pool, owner.actor, owner.draft!.id)).dataLevel).toBe(
    'confidential',
  );
  expect(
    (
      await context.pool.query('SELECT data_level FROM workspace WHERE project_id=$1', [
        context.projectId,
      ])
    ).rows[0].data_level,
  ).toBe('confidential');
});

test('JSON转义膨胀仍按32k输出分页，读取可重组原文且检索有继续位置', async () => {
  const content = ('\u0001'.repeat(300) + '😀 HIT\n').repeat(30);
  await write('草稿/转义字符.txt', content);
  let offset = 0;
  const pieces: string[] = [];
  for (let page = 0; page < 10; page++) {
    const result = await call('ws_read', { path: '草稿/转义字符.txt', offset, limit: 12000 });
    expect(JSON.stringify(result.data).length).toBeLessThanOrEqual(32000);
    const read = workspaceToolReadSchema.parse(result.data);
    pieces.push(read.text);
    if (!read.truncated) break;
    expect(read.nextOffset).toBeGreaterThan(offset);
    offset = read.nextOffset!;
  }
  expect(pieces.join('') === content).toBe(true);
  const result = await call('ws_search', { query: 'HIT', limit: 20 });
  expect(JSON.stringify(result.data).length).toBeLessThanOrEqual(32000);
  const search = workspaceToolSearchSchema.parse(result.data);
  expect(search.items.length).toBeGreaterThan(0);
  expect(search.truncated).toBe(true);
  expect(search.nextCursor).not.toBeNull();
  const offsets = search.items.map((item) => item.matchOffset);
  let cursor = search.nextCursor;
  for (let index = 0; cursor && index < 10; index++) {
    const next = await call('ws_search', { query: 'HIT', limit: 20, cursor });
    expect(JSON.stringify(next.data).length).toBeLessThanOrEqual(32000);
    const page = workspaceToolSearchSchema.parse(next.data);
    offsets.push(...page.items.map((item) => item.matchOffset));
    cursor = page.nextCursor;
  }
  expect(cursor).toBeNull();
  expect(offsets).toHaveLength(30);
  expect(new Set(offsets).size).toBe(30);
});
