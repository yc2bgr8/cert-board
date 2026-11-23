import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { rulesRunResultSchema } from '@cert-board/shared';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import { ingestParsedDocument } from '../documents/service.js';
import { createIntegrationContext } from '../test-support/context.js';
import { ToolRegistry } from './registry.js';
import { rulesRunTool } from './rules-run.js';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
class MemoryRulesStore implements DocumentBlobStore {
  private contents = new Map<string, Buffer>();
  async put(bytes: Buffer) {
    const sha256 = digest(bytes);
    this.contents.set(sha256, Buffer.from(bytes));
    return { sha256, byteSize: bytes.length };
  }
  async get(sha256: string) {
    const stored = this.contents.get(sha256);
    if (!stored) throw new Error('规则测试资料存储缺失。');
    return stored;
  }
}

let context: Awaited<ReturnType<typeof createIntegrationContext>>;
beforeEach(async () => {
  context = await createIntegrationContext();
});
afterEach(async () => {
  await context.close();
});

async function scenario() {
  const store = new MemoryRulesStore();
  const run = await context.run('MEMBER_A', 'read_only');
  const registry = new ToolRegistry(context.pool, [rulesRunTool(store)], { environment: 'test' });
  const invoke = (input: unknown, callId = randomUUID()) =>
    registry.execute({ runId: run.runId, userId: run.userId, callId }, 'rules_run', input);
  const save = (sourceKey: string, text: string, sourceMetadata: Record<string, unknown> = {}) =>
    ingestParsedDocument(context.pool, store, {
      projectId: context.projectId,
      sourceKey,
      name: `${sourceKey}.pdf`,
      sourcePath: `${sourceKey}.pdf`,
      sourceSnapshot: digest(text),
      authorType: 'external',
      dataLevel: 'internal',
      sourceMetadata,
      pages: [{ pageNumber: 1, text, method: 'text', locatorKind: 'physical_page' }],
    });
  return { store, run, invoke, save };
}

test('按选定版本识别编号变体，返回原始定位并在重放时复核来源', async () => {
  const { invoke, save } = await scenario();
  const a = await save('RULES-A', '申报编号 K170825');
  const b = await save('RULES-B', '材料编号 K170285');
  const documents = [a, b].map(({ documentId, version }) => ({ documentId, version }));
  const callId = randomUUID();
  const result = rulesRunResultSchema.parse(
    (await invoke({ documents, rules: ['R1'] }, callId)).data,
  );
  expect(result).toMatchObject({
    status: 'ok',
    pageCount: 2,
    total: 1,
    nextOffset: null,
    findings: [
      {
        ruleId: 'R1',
        status: 'candidate',
        references: [
          expect.objectContaining({ documentId: b.documentId, version: b.version, page: 1 }),
          expect.objectContaining({ documentId: a.documentId, version: a.version, page: 1 }),
        ],
      },
    ],
  });
  expect((await invoke({ documents, rules: ['R1'] }, callId)).replayed).toBe(true);
  await context.pool.query(
    "UPDATE document SET voided=true,void_reason='测试作废',version=version+1 WHERE id=$1",
    [a.documentId],
  );
  await expect(invoke({ documents, rules: ['R1'] }, callId)).rejects.toMatchObject({
    code: 'TOOL_DATA_REJECTED',
  });
  expect(
    (await invoke({ documents: [{ documentId: randomUUID(), version: 1 }], rules: ['R1'] })).data,
  ).toMatchObject({ status: 'unavailable', code: 'RULES_SOURCE_REQUIRED' });
});

test('R5 用已登记的 eSTAR 数据集及附件清单，定位与 PDF 页正文分开', async () => {
  const { invoke, save, store } = await scenario();
  const dataset = await store.put(Buffer.from('please see: Instructions for Use, MSDS'));
  const parent = await save('RULES-XFA', 'eSTAR 容器示例', {
    xfaDatasetsSha256: dataset.sha256,
    xfaAttachmentNames: ['Instructions for Use.pdf'],
  });
  const selection = [{ documentId: parent.documentId, version: parent.version }];
  const result = rulesRunResultSchema.parse(
    (await invoke({ documents: selection, rules: ['R5'] })).data,
  );
  expect(result).toMatchObject({
    status: 'ok',
    findings: [
      {
        ruleId: 'R5',
        values: [{ value: 'MSDS' }],
        references: [
          { documentId: parent.documentId, version: parent.version, locatorKind: 'xfa_datasets' },
        ],
      },
    ],
  });
});

test('误报登记按来源版本与规则版本唯一，并保留人和处理说明', async () => {
  const { save, run } = await scenario();
  const document = await save('RULES-REGISTRY', '合成检查候选');
  const sql = `INSERT INTO rule_false_positive(document_version_id,rule_id,rule_version,finding_key,reason,handling,reported_by)
    VALUES($1,'R1','1.0.0',$2,$3,$4,$5) RETURNING rule_id,reason,handling,reported_by`;
  const args = [
    document.versionId,
    digest('合成候选'),
    '样例中的两个版本适用于不同型号',
    '保留原记录',
    run.userId,
  ];
  const inserted = await context.pool.query(sql, args);
  expect(inserted.rows[0]).toMatchObject({
    rule_id: 'R1',
    reason: args[2],
    handling: args[3],
    reported_by: run.userId,
  });
  await expect(context.pool.query(sql, args)).rejects.toMatchObject({ code: '23505' });
});
