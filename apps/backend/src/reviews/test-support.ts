import { createHash, randomUUID } from 'node:crypto';
import {
  documentPageParamsSchema,
  documentPageReadSchema,
  type DocumentPageRead,
  type StructuredSubmission,
  type ToolCallContext,
} from '@cert-board/shared';
import { createIntegrationContext, type MemberKey } from '../test-support/context.js';
import { ToolRegistry, type ToolDefinition } from '../tools/registry.js';
import { submitForReviewTool } from '../tools/submit-for-review.js';
import { loadReviewPolicy } from './policy.js';

const text = '第一处 K123456\n第二处 K654321\n纯虚构测试资料，不代表正确编号。';
const sha = createHash('sha256').update(text).digest('hex');
export async function createReviewTestContext(
  options: {
    risk?: 'standard' | 'high';
    autoRead?: boolean;
    readToolName?: string;
    readText?: string;
    documentOwner?: MemberKey;
    attachment?: { path: string; text: string };
  } = {},
) {
  const base = await createIntegrationContext();
  try {
    const run = await base.run();
    const caller = { runId: run.runId, userId: run.userId, callId: randomUUID() };
    const workspaceId = (
      await base.pool.query<{ id: string }>(
        'INSERT INTO workspace(project_id) VALUES($1) RETURNING id',
        [base.projectId],
      )
    ).rows[0]!.id;
    const workspaceVersion = (
      await base.pool.query<{ id: string }>(
        "INSERT INTO workspace_version(workspace_id,project_id,number,author_type,summary,data_level) VALUES($1,$2,1,'system','审核fixture','internal') RETURNING id",
        [workspaceId, base.projectId],
      )
    ).rows[0]!.id;
    await base.pool.query(
      "INSERT INTO workspace_file(version_id,path,sha256,byte_size,data_level,media_type) VALUES($1,'交付/核查报告.md',$2,0,'internal','text/markdown')",
      [workspaceVersion, createHash('sha256').update('').digest('hex')],
    );
    if (options.attachment) {
      const { path, text } = options.attachment;
      await base.pool.query(
        "INSERT INTO workspace_file(version_id,path,sha256,byte_size,data_level,media_type) VALUES($1,$2,$3,$4,'internal','text/markdown')",
        [
          workspaceVersion,
          path,
          createHash('sha256').update(text).digest('hex'),
          Buffer.byteLength(text),
        ],
      );
    }
    await base.pool.query('UPDATE workspace SET current_version_id=$1 WHERE id=$2', [
      workspaceVersion,
      workspaceId,
    ]);
    const documentId = (
      await base.pool.query<{ id: string }>(
        "INSERT INTO document(project_id,source_key,name,source_path,owner_user_id) VALUES($1,'REVIEW-FIXTURE','虚构审核资料','fixture.txt',$2) RETURNING id",
        [base.projectId, base.userId(options.documentOwner ?? 'MEMBER_A')],
      )
    ).rows[0]!.id;
    const versionId = (
      await base.pool.query<{ id: string }>(
        "INSERT INTO document_version(document_id,version_no,source_snapshot,content_sha256,byte_size,media_type,content_kind,data_level,author_type) VALUES($1,1,$2,$2,$3,'application/json','parsed_text','internal','external') RETURNING id",
        [documentId, sha, Buffer.byteLength(text)],
      )
    ).rows[0]!.id;
    await base.pool.query(
      "INSERT INTO document_page(version_id,page_number,text,method,locator_kind) VALUES($1,1,$2,'text','physical_page')",
      [versionId, text],
    );
    const policy = await loadReviewPolicy('test');
    policy.risk = options.risk ?? 'standard';
    const readTool: ToolDefinition = {
      metadata: {
        name: options.readToolName ?? 'doc_read',
        version: 'test-doc-read-v1',
        publication: 'published',
        effect: 'read',
        modes: ['read_only', 'ask', 'full'],
        approvalInAsk: false,
        outputDataLevel: 'dynamic',
        authorizationAction: 'document.read',
        description: {
          purpose: '读取测试资料页。',
          whenToUse: '读取虚构测试资料时。',
          avoid: '不用于真实资料或生产。',
          parameters: 'id/version/page为资料定位。',
          example: { id: documentId, version: 1, page: 1 },
        },
      },
      inputSchema: documentPageParamsSchema,
      outputSchema: documentPageReadSchema,
      async execute(ctx, input) {
        const ref = documentPageParamsSchema.parse(input);
        const result = await ctx.tx.query<
          Pick<
            DocumentPageRead,
            | 'text'
            | 'dataLevel'
            | 'sourceKey'
            | 'name'
            | 'method'
            | 'locatorKind'
            | 'ocrScore'
            | 'isPlaceholder'
            | 'contentSha256'
            | 'originalSha256'
          >
        >(
          `SELECT p.text,v.data_level AS "dataLevel",d.source_key AS "sourceKey",d.name,p.method,
           p.locator_kind AS "locatorKind",p.ocr_score AS "ocrScore",p.is_placeholder AS "isPlaceholder",
           v.content_sha256 AS "contentSha256",v.original_sha256 AS "originalSha256"
           FROM document_page p JOIN document_version v ON v.id=p.version_id JOIN document d ON d.id=v.document_id
           WHERE d.id=$1 AND d.project_id=$2 AND NOT d.voided AND v.version_no=$3 AND p.page_number=$4`,
          [ref.id, ctx.projectId, ref.version, ref.page],
        );
        const row = result.rows[0];
        if (!row) throw new Error('测试资料未找到');
        const returned = options.readText ?? row.text;
        const offset = row.text.indexOf(returned);
        if (offset < 0) throw new Error('测试读取片段不属于原始页');
        const nextOffset = offset + returned.length;
        const truncated = nextOffset < row.text.length;
        return {
          data: documentPageReadSchema.parse({
            documentId: ref.id,
            sourceKey: row.sourceKey,
            name: row.name,
            version: ref.version,
            page: ref.page,
            locatorKind: row.locatorKind,
            dataLevel: row.dataLevel,
            text: returned,
            method: row.method,
            ocrScore: row.ocrScore,
            isPlaceholder: row.isPlaceholder,
            warning: null,
            offset,
            totalCharacters: row.text.length,
            truncated,
            nextOffset: truncated ? nextOffset : null,
            contentSha256: row.contentSha256,
            originalSha256: row.originalSha256,
          }),
          dataLevel: row.dataLevel,
        };
      },
      async refreshDataLevel() {
        return 'internal';
      },
    };
    const definitions = [readTool, submitForReviewTool(policy)];
    const registry = new ToolRegistry(base.pool, definitions);
    const first = { documentId, version: 1, page: 1, quote: '第一处 K123456' };
    const second = { documentId, version: 1, page: 1, quote: '第二处 K654321' };
    const submission: StructuredSubmission = {
      skill: policy.skill,
      workspaceVersion,
      conclusion: '两处写法不同，正确编号待注册人员核对。',
      claims: [
        {
          id: 'C1',
          object: '虚构资料',
          field: 'K号写法',
          value: 'K123456 / K654321',
          unit: null,
          sources: [first, second],
          status: 'checked',
        },
      ],
      evidence: [first, second],
      decisions: [],
      missing: [],
      uncertain: ['正确编号尚未判断。'],
      nextStep: '请核对原件后决定。',
    };
    async function read(reference: ToolCallContext = { ...caller, callId: randomUUID() }) {
      return registry.execute(reference, readTool.metadata.name, {
        id: documentId,
        version: 1,
        page: 1,
      });
    }
    if (options.autoRead !== false) await read();
    return {
      ...base,
      registry,
      definitions,
      caller,
      submission,
      policy,
      workspaceId,
      workspaceVersion,
      documentId,
      read,
      submit(
        input: unknown = submission,
        reference: ToolCallContext = { ...caller, callId: randomUUID() },
      ) {
        return registry.execute(reference, 'submit_for_review', input);
      },
    };
  } catch (error) {
    await base.close();
    throw error;
  }
}
