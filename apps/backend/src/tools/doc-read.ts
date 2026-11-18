import { docReadToolInputSchema, documentPageReadSchema } from '@cert-board/shared';
import { readDocumentPage } from '../documents/service.js';
import { documentInProject, refreshDocumentReference } from './document-context.js';
import type { ToolDefinition } from './registry.js';

export function docReadTool(): ToolDefinition {
  return {
    metadata: {
      name: 'doc_read',
      version: 'builtin-doc-read-v2',
      publication: 'published',
      effect: 'read',
      modes: ['read_only', 'ask', 'full'],
      approvalInAsk: false,
      outputDataLevel: 'dynamic',
      authorizationAction: 'document.read',
      description: {
        purpose: '读取当前项目资料的指定版本和页，返回原文及可追溯定位，形成实际阅读回执。',
        whenToUse:
          '从doc_search取得资料UUID、版本、页码和snippetOffset后，优先读取命中附近需要引用的完整原文。',
        avoid:
          '不知道资料UUID时先doc_search；工作区文件用ws_read。不能引用检索摘要、占位页或把提取单元冒称物理页。',
        parameters:
          'id取doc_search返回的documentId，不是资料编号；version/page取检索定位。offset是页内UTF-16位置，优先用命中项的snippetOffset，默认0；limit默认1800、最多12000。仅在引文或必要上下文未完整覆盖时，用nextOffset继续或调整offset/limit重读完整引语，不自动读完每页，不拼接缺口。',
        example: {
          id: '10000000-0000-4000-8000-000000000001',
          version: 1,
          page: 1,
          offset: 0,
          limit: 1800,
        },
      },
    },
    inputSchema: docReadToolInputSchema,
    outputSchema: documentPageReadSchema,
    async execute(ctx, input) {
      const ref = docReadToolInputSchema.parse(input);
      await documentInProject(ctx, ref.id);
      const data = await readDocumentPage(ctx.tx, ctx.actor, ref.id, ref.version, ref.page, {
        offset: ref.offset,
        limit: ref.limit,
      });
      return { data, dataLevel: data.dataLevel };
    },
    async refreshDataLevel(ctx, value) {
      const data = documentPageReadSchema.parse(value);
      return refreshDocumentReference(ctx, data, data.contentSha256);
    },
  };
}
