import {
  identifierCheckInputSchema,
  identifierCheckResultSchema,
  type DataLevel,
  type ToolMetadata,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import {
  compareIdentifiers,
  identifierInQuote,
  normalizeIdentifier,
} from '../checks/identifiers.js';
import { quoteAppears } from '../checks/quotes.js';
import { readDocumentPage } from '../documents/service.js';
import {
  documentInProject,
  highestDocumentLevel,
  refreshDocumentReference,
} from './document-context.js';
import type { ToolDefinition } from './registry.js';

const metadata: ToolMetadata = {
  name: 'identifier_check',
  version: 'builtin-identifier-check-v1',
  publication: 'published',
  effect: 'read',
  modes: ['read_only', 'ask', 'full'],
  approvalInAsk: false,
  authorizationAction: 'project.read',
  outputDataLevel: 'dynamic',
  description: {
    purpose: '执行 V2 标识符比对。核对材料编号、官方回查或台账资料的实际原文，提示可能的笔误。',
    whenToUse: '完成官方回查或取得可引用的台账原文后，要检查材料中的一项 K 号、代码或证照编号。',
    avoid:
      '待核编号和比对编号都必须有证据。不要自动修改文件，修正方案交人审核。V1、V3、V6 用 check_run。',
    parameters:
      'field 选择 k_number、product_code、regulation_number、licence_number 或 device_identifier。observed 是材料原样编号，references 最多六条已核对编号。每条含 identifier 与 evidence（documentId/version/page/quote，长页可传 doc_read 的 offset）。referenceType 为 official 或 ledger。官方引用须来自 official_lookup 存档，原文含相应 JSON 字段和编号；ledger 引用须是项目里导入的台账行。',
    example: {
      field: 'k_number',
      referenceType: 'official',
      observed: {
        identifier: 'K123456',
        evidence: {
          documentId: '10000000-0000-4000-8000-000000000001',
          version: 1,
          page: 1,
          quote: '对比器械 K123456',
        },
      },
      references: [
        {
          identifier: 'K123465',
          evidence: {
            documentId: '10000000-0000-4000-8000-000000000002',
            version: 1,
            page: 1,
            quote: '"identifier": "K123465"',
          },
        },
      ],
    },
  },
};

const officialField = {
  k_number: 'identifier',
  product_code: 'productCode',
  regulation_number: 'regulationNumber',
  licence_number: 'licenceNumber',
  device_identifier: 'identifier',
} as const;

export function identifierCheckTool(): ToolDefinition {
  return {
    metadata,
    inputSchema: identifierCheckInputSchema,
    outputSchema: identifierCheckResultSchema,
    async execute(ctx, raw) {
      try {
        const input = identifierCheckInputSchema.parse(raw);
        const cited = [input.observed, ...input.references];
        const checked = [];
        for (const [index, item] of cited.entries()) {
          const { documentId, version, page, quote, offset } = item.evidence;
          const identifier = normalizeIdentifier(input.field, item.identifier);
          await documentInProject(ctx, documentId);
          const source = await readDocumentPage(ctx.tx, ctx.actor, documentId, version, page, {
            offset,
            limit: 12000,
          });
          if (
            !quoteAppears(source.text, quote) ||
            !identifierInQuote(input.field, identifier, quote)
          )
            throw new AppError(
              422,
              'V2_EVIDENCE_MISMATCH',
              '编号没有出现在所引原文中，请重新读取正文并核对原样编号。',
            );
          if (index > 0 && input.referenceType === 'official') {
            const archive = source.webArchive;
            const attribute = officialField[input.field];
            const literal = `"${attribute}": ${JSON.stringify(item.identifier)}`;
            const path = archive ? new URL(archive.url).pathname : '';
            if (
              !source.sourceKey.startsWith('O-') ||
              archive?.sourceType !== 'official' ||
              !quote.includes(literal) ||
              (input.field === 'k_number' && path !== '/device/510k.json') ||
              (input.field === 'device_identifier' &&
                !['/api/v2/devices/lookup.json', '/api/medical-devices/deviceidentifier/'].includes(
                  path,
                ))
            )
              throw new AppError(
                422,
                'V2_OFFICIAL_SOURCE_REQUIRED',
                '请引用 official_lookup 存档中与所选类型一致的编号字段。',
              );
          }
          if (index > 0 && input.referenceType === 'ledger') {
            const trusted = await ctx.tx.query(
              `SELECT 1 FROM document_version WHERE document_id=$1 AND version_no=$2
               AND source_metadata->>'sourceRole'='licence_ledger'`,
              [documentId, version],
            );
            if (trusted.rowCount !== 1 || documentId === input.observed.evidence.documentId)
              throw new AppError(
                422,
                'V2_LEDGER_SOURCE_REQUIRED',
                '请引用另一份经过证照台账导入流程标记的资料。',
              );
          }
          checked.push({
            location: {
              identifier,
              documentId,
              version,
              page,
              sourceKey: source.sourceKey,
              contentSha256: source.contentSha256,
            },
            level: source.dataLevel,
          });
        }
        const [observed, ...references] = checked.map(({ location }) => location);
        const comparison = compareIdentifiers(
          input.field,
          observed!.identifier,
          references.map(({ identifier }) => identifier),
        );
        const guidance = {
          matched: '材料编号与至少一条所引记录一致。',
          possible_typo: '存在近似编号，请核对原件和具体器械后再提出修订，交人确认。',
          different: '材料编号与所引记录不同，请确认比对对象及编号来源。',
        };
        return {
          data: { ...comparison, observed, references, guidance: guidance[comparison.status] },
          dataLevel: highestDocumentLevel(checked.map(({ level }) => level)),
        };
      } catch (error) {
        if (error instanceof AppError && error.code.startsWith('V2_'))
          return {
            data: { status: 'unavailable', code: error.code, message: error.message },
            dataLevel: ctx.maxDataLevel,
          };
        throw error;
      }
    },
    async refreshDataLevel(ctx, raw) {
      const result = identifierCheckResultSchema.parse(raw);
      if (result.status === 'unavailable') return ctx.maxDataLevel;
      const { observed, references } = result;
      const levels: DataLevel[] = [];
      for (const ref of [observed, ...references])
        levels.push(await refreshDocumentReference(ctx, ref, ref.contentSha256));
      return highestDocumentLevel(levels);
    },
  };
}
