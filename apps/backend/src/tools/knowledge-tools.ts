import { z } from 'zod';
import {
  factProposalResultSchema,
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
import { readPublishedTemplate } from '../knowledge/publication.js';
import { readRulePack, refreshRulePackLevel } from '../knowledge/rule-packs.js';
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
        purpose: '读取市场规则包的固定版本、已审阅发布的公司模板，或读取当前项目内有效的确认事实。',
        whenToUse: '按市场规则核查事项、采用公司模板拟稿，或查找已确认的项目事实时使用。',
        avoid:
          '读取页原文用 doc_read，查现时公开记录用 official_lookup。开发规则包仍待注册人员确认。',
        parameters:
          'kind=rule_pack 或 template 时给 code。kind=facts 可按 subject 与 field 精确过滤，分页用 afterId，单页最多 10 条。',
        example: { kind: 'rule_pack', code: 'us_fda_m02' },
      },
    },
    inputSchema: knowledgeGetInputSchema,
    outputSchema: knowledgeGetResultSchema,
    async execute(ctx, input) {
      const request = knowledgeGetInputSchema.parse(input);
      switch (request.kind) {
        case 'rule_pack':
          return readRulePack(ctx, request.code, process.env.NODE_ENV ?? 'production');
        case 'template':
          return readPublishedTemplate(ctx, request.code);
        case 'facts':
          return readConfirmedFacts(ctx, request);
      }
    },
    async refreshDataLevel(ctx, input) {
      const cached = knowledgeGetResultSchema.parse(input);
      if (cached.kind === 'facts') return refreshConfirmedFactsLevel(ctx, cached.facts);
      if (cached.kind === 'template') return cached.template?.dataLevel ?? 'internal';
      return refreshRulePackLevel(ctx, cached.pack, process.env.NODE_ENV ?? 'production');
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
    outputSchema: factProposalResultSchema,
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
      return refreshFactProposalLevel(ctx, factProposalResultSchema.parse(input));
    },
    undo: {
      beforeSchema: z.strictObject({ existed: z.literal(false) }),
      capture: async () => captureFactProposal(),
      currentVersion: (ctx, record) => factCandidateVersion(ctx, record.targetId),
      apply: cancelFactProposal,
    },
  };
}
