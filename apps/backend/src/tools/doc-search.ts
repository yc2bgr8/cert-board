import {
  docSearchToolInputSchema,
  documentSearchResultSchema,
  type DataLevel,
} from '@cert-board/shared';
import { searchDocuments } from '../documents/service.js';
import {
  documentProject,
  highestDocumentLevel,
  refreshDocumentReference,
} from './document-context.js';
import type { ToolDefinition } from './registry.js';

export function docSearchTool(): ToolDefinition {
  return {
    metadata: {
      name: 'doc_search',
      version: 'builtin-doc-search-v2',
      publication: 'published',
      effect: 'read',
      modes: ['read_only', 'ask', 'full'],
      approvalInAsk: false,
      outputDataLevel: 'dynamic',
      authorizationAction: 'document.read',
      description: {
        purpose:
          '在当前项目有效资料的最新版本中检索原样子串，返回最多300字符摘要、真实摘要起点snippetOffset、资料UUID、版本和页码。',
        whenToUse:
          '找资料或定位字段写法时先窄检索，选择2–3个相关命中位置，用doc_read从各自snippetOffset读取附近原文。',
        avoid:
          '不是语义检索，不支持正则、通配符或OR；摘要不算已读原文。英文资料优先predicate device或510(k) summary；需要补证时再换更具体词，不用单字K宽检索，也不因中文词无结果断言不存在。',
        parameters:
          'query为1–200字符大小写不敏感子串；offset是结果分页游标，默认0；limit默认10、最多30，初次可用3。每项snippetOffset是页内UTF-16摘要起点，供doc_read.offset使用；仅资料名或编号匹配时为0。hasMore不代表必须遍历，证据不足时才按nextOffset补查或缩小词。项目由当前对话决定，不接收projectId。',
        example: { query: 'predicate device', offset: 0, limit: 3 },
      },
    },
    inputSchema: docSearchToolInputSchema,
    outputSchema: documentSearchResultSchema,
    async execute(ctx, input) {
      const options = docSearchToolInputSchema.parse(input);
      const found = await searchDocuments(ctx.tx, ctx.actor, documentProject(ctx), options);
      const data = { ...found, items: [...found.items] };
      // 同时留出工具JSON及私有过程事件的封装空间；缩页而不是截断引文字符串。
      while (
        data.items.length > 1 &&
        (JSON.stringify(data).length > 30000 ||
          Buffer.byteLength(JSON.stringify(data), 'utf8') > 56000)
      ) {
        data.items.pop();
        data.hasMore = true;
        data.nextOffset = options.offset + data.items.length;
      }
      return { data, dataLevel: highestDocumentLevel(data.items.map((item) => item.dataLevel)) };
    },
    async refreshDataLevel(ctx, value) {
      const data = documentSearchResultSchema.parse(value);
      documentProject(ctx);
      const levels: DataLevel[] = [];
      for (const item of data.items) levels.push(await refreshDocumentReference(ctx, item));
      return highestDocumentLevel(levels);
    },
  };
}
