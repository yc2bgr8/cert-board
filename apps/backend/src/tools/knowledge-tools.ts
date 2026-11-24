import { z } from 'zod';
import {
  factCandidateSchema,
  factProposalSchema,
  knowledgeGetInputSchema,
  knowledgeGetResultSchema,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import {
  cancelFactProposal,
  captureFactProposal,
  factCandidateVersion,
  previewFactProposal,
  proposeFact,
  readConfirmedFacts,
  refreshConfirmedFactsLevel,
  refreshFactProposalLevel,
} from '../knowledge/facts.js';
import { readRulePack } from '../knowledge/rule-packs.js';
import type { ToolDefinition } from './registry.js';

export function knowledgeGetTool(): ToolDefinition {
  return {
    metadata: {
      name: 'knowledge_get',
      version: 'builtin-knowledge-get-v1',
      publication: 'published',
      effect: 'read',
      modes: ['read_only', 'ask', 'full'],
      approvalInAsk: false,
      outputDataLevel: 'dynamic',
      authorizationAction: 'project.read',
      description: {
        purpose: '读取市场规则包的固定版本，或读取当前项目内由人确认且仍有效的事实。',
        whenToUse: '核查美国年度注册、列名或美国代理人时，先加载规则及已经确认的项目资料。',
        avoid:
          '读取页原文用 doc_read，查现时公开记录用 official_lookup。开发规则包仍待注册人员确认。',
        parameters:
          'kind=rule_pack 时给 code。kind=facts 可按 subject 与 field 精确过滤，分页用 afterId，单页最多 10 条。',
        example: { kind: 'rule_pack', code: 'us_fda_m02' },
      },
    },
    inputSchema: knowledgeGetInputSchema,
    outputSchema: knowledgeGetResultSchema,
    async execute(ctx, input) {
      const request = knowledgeGetInputSchema.parse(input);
      return request.kind === 'rule_pack'
        ? readRulePack(ctx, request.code, process.env.NODE_ENV ?? 'production')
        : readConfirmedFacts(ctx, request);
    },
    async refreshDataLevel(ctx, input) {
      const cached = knowledgeGetResultSchema.parse(input);
      if (cached.kind === 'facts') return refreshConfirmedFactsLevel(ctx, cached.facts);
      if (
        cached.pack?.publication === 'development' &&
        !['test', 'development'].includes(process.env.NODE_ENV ?? 'production')
      )
        throw new AppError(403, 'RULE_PACK_DEVELOPMENT_ONLY', '当前环境只可读取正式发布的规则包。');
      return 'internal';
    },
  };
}

export function factProposeTool(): ToolDefinition {
  return {
    metadata: {
      name: 'fact_propose',
      version: 'builtin-fact-propose-v1',
      publication: 'published',
      effect: 'reversible_write',
      modes: ['ask', 'full'],
      approvalInAsk: true,
      outputDataLevel: 'dynamic',
      authorizationAction: 'record.write',
      description: {
        purpose: '为当前项目创建待核实的事实候选，保留原文证据和处理期限，由注册人员确认。',
        whenToUse: '已经用 doc_read 读取到能支持真实值的本项目资料，并发现需要新增或核对的事实。',
        avoid: '仅查询时用 knowledge_get。证据不足时报告缺口。候选不会改写已确认事实。',
        parameters:
          'subject 写资料中可识别的对象，field 用英文键，value 和 unit 写候选值。evidence 填资料编号、版本、页码、逐字引语。dueAt 可用带时区的 ISO 时间。',
        example: {
          subject: '虚构企业',
          field: 'registration_number',
          value: '示例编号',
          unit: null,
          evidence: {
            documentId: '10000000-0000-4000-8000-000000000001',
            version: 1,
            page: 1,
            quote: '登记号：示例编号',
          },
        },
      },
    },
    inputSchema: factProposalSchema,
    outputSchema: factCandidateSchema,
    async prepareApproval(ctx, input) {
      return previewFactProposal(ctx, factProposalSchema.parse(input));
    },
    async execute(ctx, input, before) {
      if (!before || before.targetType !== 'fact_candidate')
        throw new AppError(
          500,
          'FACT_ROLLBACK_CONTEXT_MISSING',
          '没有建立撤销凭据，请联系维护人员核对事实候选。',
        );
      return proposeFact(ctx, factProposalSchema.parse(input), before.targetId);
    },
    async refreshDataLevel(ctx, input) {
      return refreshFactProposalLevel(ctx, factCandidateSchema.parse(input));
    },
    undo: {
      beforeSchema: z.strictObject({ existed: z.literal(false) }),
      capture: async () => captureFactProposal(),
      currentVersion: (ctx, record) => factCandidateVersion(ctx, record.targetId),
      apply: cancelFactProposal,
    },
  };
}
