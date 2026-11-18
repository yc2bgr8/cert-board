import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  documentPageReadSchema,
  documentSearchResultSchema,
  skillLoadResultSchema,
  reviewSubmitResultSchema,
  type DocumentImport,
  type StructuredSubmission,
} from '@cert-board/shared';
import { createIntegrationContext } from '../test-support/context.js';
import { createToolRuntime } from '../agent/tool-runtime.js';
import { readT1Fixture } from '../documents/t1-seed.js';
import { ingestParsedDocument } from '../documents/service.js';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import { buildDocumentTools } from './document-tools.js';
import { submitForReviewTool } from './submit-for-review.js';
import { loadReviewPolicy } from '../reviews/policy.js';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
class MemoryStore implements DocumentBlobStore {
  private values = new Map<string, Buffer>();
  async put(value: Buffer) {
    const sha256 = digest(value);
    this.values.set(sha256, value);
    return { sha256, byteSize: value.byteLength };
  }
  async get(sha256: string) {
    const value = this.values.get(sha256);
    if (!value) throw Error('fixture_blob_missing');
    return value;
  }
}
let context: Awaited<ReturnType<typeof createIntegrationContext>>;
let runtime: Awaited<ReturnType<typeof createToolRuntime>>;
let caller: { runId: string; userId: string; callId: string };
let store: MemoryStore;
let docs: Map<string, { id: string; input: DocumentImport }>;
let workspaceVersion: string;
const fixture = readT1Fixture();
beforeEach(async () => {
  context = await createIntegrationContext();
  store = new MemoryStore();
  docs = new Map();
  const data = await fixture;
  for (const source of data.documents.filter((item) =>
    ['D001', 'D018', 'D035'].includes(item.id),
  )) {
    const input: DocumentImport = {
      projectId: context.projectId,
      sourceKey: source.id,
      name: source.name,
      sourcePath: source.path,
      sourceSnapshot: data.snapshot,
      originalSha256: source.sha256,
      dataLevel: 'internal',
      authorType: 'external',
      sourceMetadata: {},
      pages: data.pages
        .filter((page) => page.doc === source.id)
        .map((page) => ({
          pageNumber: page.page,
          text: page.text,
          method: page.method,
          locatorKind: page.method === 'docx' ? 'extraction_unit' : 'physical_page',
          ocrScore: page.ocr_score ?? null,
          isPlaceholder: false,
        })),
    };
    const result = await ingestParsedDocument(context.pool, store, input);
    docs.set(source.id, { id: result.documentId, input });
  }
  const workspace = (
    await context.pool.query<{ id: string }>(
      'INSERT INTO workspace(project_id) VALUES($1) RETURNING id',
      [context.projectId],
    )
  ).rows[0]!.id;
  workspaceVersion = (
    await context.pool.query<{ id: string }>(
      "INSERT INTO workspace_version(workspace_id,project_id,number,author_type,summary,data_level) VALUES($1,$2,1,'system','资料工具fixture','internal') RETURNING id",
      [workspace, context.projectId],
    )
  ).rows[0]!.id;
  await context.pool.query('UPDATE workspace SET current_version_id=$1 WHERE id=$2', [
    workspaceVersion,
    workspace,
  ]);
  const source = await context.run('MEMBER_A', 'ask');
  caller = { runId: source.runId, userId: source.userId, callId: randomUUID() };
  runtime = await createToolRuntime({
    pool: context.pool,
    definitions: [...buildDocumentTools(), submitForReviewTool(await loadReviewPolicy('test'))],
    runId: source.runId,
    userId: source.userId,
    ownerId: randomUUID(),
    signal: new AbortController().signal,
    environment: 'test',
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await context?.close();
});
const invoke = (name: string, args: unknown, callId = randomUUID()) =>
  runtime.registry.execute({ ...caller, callId }, name, args);

test('真实T1按英文/文件名检索并分页；UUID和版本页可读，摘要不会充当doc_read', async () => {
  const empty = documentSearchResultSchema.parse(
    (await invoke('doc_search', { query: '对比器械' })).data,
  );
  expect(empty.items).toHaveLength(0);
  const first = documentSearchResultSchema.parse(
    (await invoke('doc_search', { query: '510(k) summary', limit: 1 })).data,
  );
  expect(first.items).toHaveLength(1);
  expect(first.hasMore).toBe(true);
  expect(first.nextOffset).toBe(1);
  const rest = documentSearchResultSchema.parse(
    (await invoke('doc_search', { query: '510(k) summary', offset: first.nextOffset, limit: 30 }))
      .data,
  );
  expect(rest.items).toHaveLength(5);
  expect(rest.hasMore).toBe(false);
  for (const item of [...first.items, ...rest.items]) {
    const original = docs
      .get(item.sourceKey)!
      .input.pages.find((page) => page.pageNumber === item.page)!.text;
    expect(original.slice(item.snippetOffset, item.snippetOffset + item.snippet.length)).toBe(
      item.snippet,
    );
  }
  const hit = first.items[0]!;
  const nearby = documentPageReadSchema.parse(
    (
      await invoke('doc_read', {
        id: hit.documentId,
        version: hit.version,
        page: hit.page,
        offset: hit.snippetOffset,
      })
    ).data,
  );
  expect(nearby.offset).toBe(hit.snippetOffset);
  expect(nearby.text.length).toBeLessThanOrEqual(1800);
  expect(nearby.text.startsWith(hit.snippet)).toBe(true);
  const read = documentPageReadSchema.parse(
    (await invoke('doc_read', { id: docs.get('D001')!.id, version: 1, page: 1, limit: 8000 })).data,
  );
  expect(read.sourceKey).toBe('D001');
  expect(read.locatorKind).toBe('extraction_unit');
  expect(read.text).toContain('K170825');
  expect(read.text).toContain('K170285');
  expect(read.warning).toContain('原始文件尚未导入');
  const proof = (
    await context.pool.query(
      "SELECT content_json FROM conversation_tool_result WHERE content_json #>> '{result,data,documentId}'=$1",
      [read.documentId],
    )
  ).rows;
  expect(
    proof.some((row) => documentPageReadSchema.safeParse(row.content_json.result.data).success),
  ).toBe(true);
});

test('doc_read工具确实复用当前事务且不另连Pool，长文本续读保持原文与Unicode边界', async () => {
  const connect = vi.spyOn(context.pool, 'connect');
  const before = connect.mock.calls.length;
  const target = docs.get('D001')!;
  const full = target.input.pages[0]!.text;
  const first = documentPageReadSchema.parse(
    (await invoke('doc_read', { id: target.id, version: 1, page: 1, limit: 300 })).data,
  );
  expect(connect.mock.calls.length - before).toBe(1);
  expect(first.truncated).toBe(true);
  expect(first.nextOffset).toBe(300);
  const second = documentPageReadSchema.parse(
    (
      await invoke('doc_read', {
        id: target.id,
        version: 1,
        page: 1,
        offset: first.nextOffset,
        limit: 12000,
      })
    ).data,
  );
  expect(first.text + second.text === full).toBe(true);
});

test('其他项目UUID和占位页拒绝，不保存成功阅读证明', async () => {
  const other = (
    await context.pool.query<{ id: string }>(
      "INSERT INTO cert_project(name,project_type,market,pathway,owner_user_id) VALUES('另一项目','registration','US','510(k)',$1) RETURNING id",
      [caller.userId],
    )
  ).rows[0]!.id;
  const imported = await ingestParsedDocument(context.pool, store, {
    ...docs.get('D001')!.input,
    projectId: other,
  });
  const count = (await context.pool.query('SELECT id FROM conversation_tool_result')).rowCount;
  await expect(
    invoke('doc_read', { id: imported.documentId, version: 1, page: 1 }),
  ).rejects.toMatchObject({ code: 'TOOL_TARGET_UNAVAILABLE' });
  expect((await context.pool.query('SELECT id FROM conversation_tool_result')).rowCount).toBe(
    count,
  );
  const placeholder = await ingestParsedDocument(context.pool, store, {
    ...docs.get('D001')!.input,
    sourceKey: 'PLACEHOLDER',
    sourceSnapshot: digest('placeholder'),
    pages: [
      {
        pageNumber: 1,
        text: 'Please wait... Adobe',
        method: 'text',
        locatorKind: 'physical_page',
        ocrScore: null,
        isPlaceholder: true,
      },
    ],
  });
  await expect(
    invoke('doc_read', { id: placeholder.documentId, version: 1, page: 1 }),
  ).rejects.toMatchObject({ code: 'TOOL_DATA_REJECTED' });
});

test('相同doc_read幂等重放，随后来源升密抬高对话，作废后拒绝旧结果', async () => {
  const target = docs.get('D001')!;
  const callId = randomUUID();
  const args = { id: target.id, version: 1, page: 1 };
  const first = await invoke('doc_read', args, callId);
  expect((await invoke('doc_read', args, callId)).replayed).toBe(true);
  await ingestParsedDocument(context.pool, store, {
    ...target.input,
    sourceSnapshot: digest('classified-version'),
    dataLevel: 'confidential',
  });
  const replay = await invoke('doc_read', args, callId);
  expect(replay.invocationId).toBe(first.invocationId);
  expect(replay.dataLevel).toBe('confidential');
  expect(
    (await context.pool.query('SELECT max_data_level FROM run WHERE id=$1', [caller.runId])).rows[0]
      ?.max_data_level,
  ).toBe('confidential');
  await context.pool.query("UPDATE document SET voided=true,void_reason='测试作废' WHERE id=$1", [
    target.id,
  ]);
  await expect(invoke('doc_read', args, callId)).rejects.toBeDefined();
});

test('doc_search缓存也重验所有返回页，不能重放作废来源', async () => {
  const callId = randomUUID();
  const first = await invoke('doc_search', { query: '510(k) summary' }, callId);
  const items = documentSearchResultSchema.parse(first.data).items;
  await context.pool.query("UPDATE document SET voided=true,void_reason='测试作废' WHERE id=$1", [
    items[0]!.documentId,
  ]);
  await expect(invoke('doc_search', { query: '510(k) summary' }, callId)).rejects.toBeDefined();
});

test('真实doc_read回执可供V1和提交审核，不能只用检索摘要提交', async () => {
  const target = docs.get('D001')!;
  const citations = ['K170825', 'K170285'].map((quote) => ({
    documentId: target.id,
    version: 1,
    page: 1,
    quote,
  }));
  const input: StructuredSubmission = {
    skill: { id: 'R09', version: '0.1.0' },
    workspaceVersion,
    conclusion: '两处写法不一致，正确编号待确认。',
    claims: [
      {
        id: 'C1',
        object: '对比器械',
        field: 'K号写法',
        value: '两种不同写法',
        unit: null,
        sources: citations,
        status: 'checked',
      },
    ],
    evidence: citations,
    decisions: [],
    missing: [],
    uncertain: ['正确编号尚未核实。'],
    nextStep: '核对原件后审核。',
  };
  await invoke('doc_search', { query: '510(k) summary' });
  await expect(invoke('submit_for_review', input)).rejects.toMatchObject({
    code: 'TOOL_DATA_REJECTED',
  });
  await invoke('doc_read', { id: target.id, version: 1, page: 1, limit: 8000 });
  const result = await invoke('submit_for_review', input);
  expect(reviewSubmitResultSchema.parse(result.data).status).toBe('pending');
  const refs = (await context.pool.query('SELECT evidence_refs FROM review_card')).rows[0]!
    .evidence_refs;
  expect(refs).toHaveLength(2);
  expect(refs.every((ref: { readInvocationId: string }) => Boolean(ref.readInvocationId))).toBe(
    true,
  );
});

test('skill_load由数据库Agent归属限定索引，不能通过工具参数跨Agent读技能', async () => {
  const value = skillLoadResultSchema.parse((await invoke('skill_load', { id: 'R09' })).data);
  expect(value.skill.agentCode).toBe('registration');
  await expect(invoke('skill_load', { id: 'M02' })).rejects.toBeDefined();
  const project = (
    await context.pool.query<{ id: string }>(
      "INSERT INTO cert_project(name,project_type,market,pathway,owner_user_id) VALUES('维护','maintenance','US','年度核查',$1) RETURNING id",
      [caller.userId],
    )
  ).rows[0]!.id;
  const goal = (
    await context.pool.query<{ id: string }>(
      "INSERT INTO goal(project_id,owner_user_id,title,acceptance_criteria) VALUES($1,$2,'核查','引用原文') RETURNING id",
      [project, caller.userId],
    )
  ).rows[0]!.id;
  const conversation = (
    await context.pool.query<{ id: string }>(
      "INSERT INTO conversation(project_id,user_id,goal_id,title,agent_code) VALUES($1,$2,$3,'核查','maintenance') RETURNING id",
      [project, caller.userId, goal],
    )
  ).rows[0]!.id;
  const run = (
    await context.pool.query<{ id: string }>(
      'INSERT INTO run(conversation_id,user_id,project_id,goal_id) VALUES($1,$2,$3,$4) RETURNING id',
      [conversation, caller.userId, project, goal],
    )
  ).rows[0]!.id;
  const other = await createToolRuntime({
    pool: context.pool,
    definitions: buildDocumentTools(),
    runId: run,
    userId: caller.userId,
    ownerId: randomUUID(),
    signal: new AbortController().signal,
    environment: 'test',
  });
  const result = await other.registry.execute(
    { runId: run, userId: caller.userId, callId: randomUUID() },
    'skill_load',
    { id: 'M02' },
  );
  expect(skillLoadResultSchema.parse(result.data).reviewPolicy.skill.id).toBe('M02');
});
