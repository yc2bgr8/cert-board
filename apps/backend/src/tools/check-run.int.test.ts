import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { checkReportSchema, type StructuredSubmission } from '@cert-board/shared';
import { createIntegrationContext } from '../test-support/context.js';
import { ToolRegistry } from './registry.js';
import { checkRunTool } from './check-run.js';

let context: Awaited<ReturnType<typeof createIntegrationContext>>;
let registry: ToolRegistry;
let caller: { runId: string; userId: string; callId: string };
let input: StructuredSubmission;
let documentId: string;
beforeAll(async () => {
  context = await createIntegrationContext();
  const { conversationId: _conversation, ...run } = await context.run('MEMBER_A', 'read_only');
  caller = run;
  const workspace = (
    await context.pool.query<{ id: string }>(
      'INSERT INTO workspace(project_id) VALUES($1) RETURNING id',
      [context.projectId],
    )
  ).rows[0]!.id;
  const version = (
    await context.pool.query<{ id: string }>(
      "INSERT INTO workspace_version(workspace_id,project_id,number,author_type,summary,data_level) VALUES($1,$2,1,'system','工具检查fixture','internal') RETURNING id",
      [workspace, context.projectId],
    )
  ).rows[0]!.id;
  await context.pool.query('UPDATE workspace SET current_version_id=$1 WHERE id=$2', [
    version,
    workspace,
  ]);
  documentId = (
    await context.pool.query<{ id: string }>(
      "INSERT INTO document(project_id,source_key,name,source_path,owner_user_id) VALUES($1,'CHECK-TOOL','合成检查资料','check.txt',$2) RETURNING id",
      [context.projectId, caller.userId],
    )
  ).rows[0]!.id;
  const documentVersion = (
    await context.pool.query<{ id: string }>(
      "INSERT INTO document_version(document_id,version_no,source_snapshot,content_sha256,byte_size,media_type,content_kind,data_level,author_type) VALUES($1,1,$2,$3,100,'text/plain','parsed_text','internal','external') RETURNING id",
      [documentId, 'a'.repeat(64), 'b'.repeat(64)],
    )
  ).rows[0]!.id;
  await context.pool.query(
    "INSERT INTO document_page(version_id,page_number,text,method,locator_kind) VALUES($1,1,'只在私有资料中出现的合成原文：K123456。','text','physical_page')",
    [documentVersion],
  );
  const citation = { documentId, version: 1, page: 1, quote: 'K123456' };
  input = {
    skill: { id: 'R09', version: '0.1.0' },
    workspaceVersion: version,
    conclusion: '写法已逐字核对，编号真实性待确认。',
    claims: [
      {
        id: 'C1',
        object: '资料',
        field: 'K号',
        value: 'K123456',
        unit: null,
        sources: [citation],
        status: 'checked',
      },
    ],
    evidence: [citation],
    missing: [],
    uncertain: ['正确编号未回查。'],
    nextStep: '交注册人员审核。',
  };
  registry = new ToolRegistry(context.pool, [checkRunTool()], { environment: 'test' });
});
afterAll(async () => {
  await context?.close();
});

test('真实check_run注册工具支持只读模式、复用同一事务且幂等，结果不含原文', async () => {
  const connect = vi.spyOn(context.pool, 'connect');
  try {
    const result = await registry.execute(caller, 'check_run', input);
    expect(checkReportSchema.parse(result.data).passed).toBe(true);
    expect(result.dataLevel).toBe('internal');
    expect(connect.mock.calls.length).toBe(1);
    expect(JSON.stringify(result.data)).not.toContain('只在私有资料中出现的合成原文');
  } finally {
    connect.mockRestore();
  }
  expect((await registry.execute(caller, 'check_run', input)).replayed).toBe(true);
  const row = (
    await context.pool.query('SELECT COUNT(*)::int AS count FROM tool_invocation WHERE run_id=$1', [
      caller.runId,
    ])
  ).rows[0];
  expect(row.count).toBe(1);
});

test('缓存检查仍重验资料有效性，作废后不重放旧通过结论', async () => {
  await context.pool.query(
    "UPDATE document SET voided=true,void_reason='合成作废',version=version+1 WHERE id=$1",
    [documentId],
  );
  await expect(registry.execute(caller, 'check_run', input)).rejects.toMatchObject({
    statusCode: 404,
  });
});
