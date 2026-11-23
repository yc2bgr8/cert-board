import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  rulesRunInputSchema,
  rulesRunResultSchema,
  sha256Schema,
  type DataLevel,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { authorize } from '../auth/authorization.js';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import type { DocumentParserClient } from '../documents/docsvc-client.js';
import { runConsistencyRules, type RuleDocument } from '../rules/engine.js';
import { documentProject, highestDocumentLevel } from './document-context.js';
import type { ToolDefinition, ToolExecutionContext } from './registry.js';

type Version = { documentId: string; version: number };
type Source = Version & {
  versionId: string;
  sourceKey: string;
  name: string;
  owner: string;
  dataLevel: DataLevel;
  contentSha256: string;
  originalSha: string | null;
  kind: 'original' | 'parsed_text';
  format: string | null;
  parseState: string | null;
  metadata: unknown;
};
export type RulesOriginals = {
  store: DocumentBlobStore;
  parser: Pick<DocumentParserClient, 'estarDatasets'>;
};
type Page = { versionId: string; page: number; text: string };
const fixtureMetadata = z.object({
  duplicateOf: z.string().nullable().optional(),
  xfaDatasetsSha256: sha256Schema.optional(),
  xfaAttachmentNames: z.array(z.string().min(1).max(255)).max(256).optional(),
});

async function selectedSources(ctx: ToolExecutionContext, selected?: Version[]) {
  const projectId = documentProject(ctx);
  const { rows } = await ctx.tx.query<Source>(
    `SELECT d.id AS "documentId",d.source_key AS "sourceKey",d.owner_user_id AS owner,
      COALESCE(v.source_metadata->'_certImport'->>'name',d.name) AS name,
      v.id AS "versionId",v.version_no AS version,v.content_sha256 AS "contentSha256",
      v.original_sha256 AS "originalSha",v.content_kind AS kind,
      v.source_metadata AS metadata,t.format,t.state AS "parseState",
      (SELECT sv.data_level FROM document_version sv WHERE sv.document_id=d.id
       ORDER BY sv.data_level DESC LIMIT 1) AS "dataLevel"
     FROM document d JOIN document_version v ON v.document_id=d.id
     LEFT JOIN document_parse_task t ON t.version_id=v.id
     WHERE d.project_id=$1 AND NOT d.voided
       AND CASE WHEN $2::uuid[] IS NULL THEN v.version_no=(
         SELECT max(lv.version_no) FROM document_version lv WHERE lv.document_id=d.id
       ) ELSE (d.id,v.version_no) IN (SELECT * FROM unnest($2::uuid[],$3::int[])) END
     ORDER BY d.source_key,v.version_no LIMIT 65`,
    [
      projectId,
      selected?.map(({ documentId }) => documentId) ?? null,
      selected?.map(({ version }) => version) ?? null,
    ],
  );
  if (rows.length > 64)
    throw new AppError(422, 'RULES_SOURCE_LIMIT', '资料版本超过 64 个，请先选一组资料版本。');
  if (
    !rows.length ||
    (selected && rows.length !== selected.length) ||
    rows.some(
      (row) => !authorize(ctx.actor, 'document.read', { projectId, ownerUserId: row.owner }),
    )
  )
    throw new AppError(
      404,
      'RULES_SOURCE_REQUIRED',
      '没有可检查的资料版本，请从本项目取得资料编号及版本。',
    );
  return rows;
}

async function pagesFor(ctx: ToolExecutionContext, sources: Source[]) {
  const versionIds = sources
    .filter(({ parseState }) => parseState === null || parseState === 'ready')
    .map(({ versionId }) => versionId);
  const { rows } = await ctx.tx.query<{ count: number; size: string }>(
    `SELECT count(*)::int AS count,COALESCE(sum(octet_length(text)),0)::text AS size
       FROM document_page WHERE version_id=ANY($1::uuid[]) AND NOT is_placeholder`,
    [versionIds],
  );
  if (rows[0]!.count > 1200 || Number(rows[0]!.size) > 8 * 1024 * 1024)
    throw new AppError(
      422,
      'RULES_PAGE_LIMIT',
      '页数或总正文超过检查上限，请按相关资料组分批检查。',
    );
  return (
    await ctx.tx.query<Page>(
      `SELECT version_id AS "versionId",page_number AS page,text
       FROM document_page WHERE version_id=ANY($1::uuid[]) AND NOT is_placeholder
       ORDER BY page_number`,
      [versionIds],
    )
  ).rows;
}

function summary(source: Source) {
  const { documentId, sourceKey, version, contentSha256 } = source;
  return { documentId, sourceKey, version, contentSha256 };
}

async function attachEstar(
  source: Source,
  parsedStore: DocumentBlobStore,
  originals: RulesOriginals | undefined,
  signal?: AbortSignal,
) {
  const fixture = fixtureMetadata.safeParse(source.metadata);
  if (fixture.success && fixture.data.xfaDatasetsSha256 && fixture.data.xfaAttachmentNames) {
    return {
      bytes: await parsedStore.get(fixture.data.xfaDatasetsSha256),
      attachmentNames: fixture.data.xfaAttachmentNames,
    };
  }
  if (
    !originals ||
    source.kind !== 'original' ||
    source.format !== 'estar' ||
    source.parseState !== 'ready' ||
    !source.originalSha
  )
    return null;
  return originals.parser.estarDatasets(
    await originals.store.get(source.originalSha),
    source.originalSha,
    signal,
  );
}

export function rulesRunTool(store: DocumentBlobStore, originals?: RulesOriginals): ToolDefinition {
  return {
    metadata: {
      name: 'rules_run',
      version: 'builtin-consistency-rules-v1',
      publication: 'published',
      effect: 'read',
      modes: ['read_only', 'ask', 'full'],
      approvalInAsk: false,
      authorizationAction: 'project.read',
      outputDataLevel: 'dynamic',
      description: {
        purpose: '对项目的实际资料版本运行 RV-05 八类一致性规则，给出候选差异和可回查的位置。',
        whenToUse:
          '要先做同名版本、申报编号、联系人、参数、型号、eSTAR 附件、实验室结论栏或接触时长核对。',
        avoid:
          '候选需逐条核对来源，不能据此自动修订原件或作法规结论。引用正文前用 doc_read；官方编号核对用 official_lookup 和 identifier_check。',
        parameters:
          'documents 可列最多 64 个 documentId/version；省略时检查该项目选得的当前版本。rules 可指定 R0 至 R7，默认全跑；limit 最多 10，下一批用 nextOffset，保留同一资料版本清单。xfa_datasets 定位指 eSTAR 原件的数据集，不能当作 PDF 页正文。',
        example: { rules: ['R1', 'R3'], limit: 6 },
      },
    },
    inputSchema: rulesRunInputSchema,
    outputSchema: rulesRunResultSchema,
    async execute(ctx, raw) {
      try {
        const input = rulesRunInputSchema.parse(raw);
        const sources = await selectedSources(ctx, input.documents);
        if (ctx.signal?.aborted)
          throw new AppError(409, 'RULES_STOPPED', '当前运行已停止，本次规则检查未完成。');
        const pages = await pagesFor(ctx, sources);
        const documents: RuleDocument[] = [];
        const notices: string[] = [];
        const coverageNotices: string[] = [];
        const byVersion = new Map(sources.map((source) => [source.versionId, source]));
        const selected = new Set(input.rules);
        let estarCount = 0;
        for (const source of sources) {
          if (ctx.signal?.aborted)
            throw new AppError(409, 'RULES_STOPPED', '当前运行已停止，本次规则检查未完成。');
          const meta = fixtureMetadata.safeParse(source.metadata);
          const isEstar =
            source.format === 'estar' || Boolean(meta.success && meta.data.xfaDatasetsSha256);
          const document: RuleDocument = {
            key: source.versionId,
            name: source.name,
            isEstar,
            duplicate: Boolean(
              meta.success &&
              meta.data.duplicateOf &&
              source.originalSha &&
              sources.some(
                (other) =>
                  other.versionId !== source.versionId &&
                  other.sourceKey === meta.data.duplicateOf &&
                  other.originalSha === source.originalSha,
              ),
            ),
            pages: pages
              .filter((page) => page.versionId === source.versionId)
              .map(({ page, text }) => ({ page, text })),
          };
          if (selected.has('R5') && isEstar) {
            estarCount++;
            if (estarCount > 3)
              throw new AppError(
                422,
                'RULES_ESTAR_LIMIT',
                '请在同一批中最多选择三个 eSTAR 容器，再运行附件核对。',
              );
            let result;
            try {
              result = await attachEstar(source, store, originals, ctx.signal);
              if (result) {
                document.referencesText = new TextDecoder('utf-8', { fatal: true }).decode(
                  result.bytes,
                );
                document.attachmentNames = result.attachmentNames;
              }
            } catch (error) {
              if (!(error instanceof AppError || error instanceof TypeError)) throw error;
            }
            if (!document.referencesText)
              coverageNotices.push(
                `${source.sourceKey} 的 eSTAR 数据集或完整附件清单不可用，R5 待人工核对。`,
              );
          }
          if (!document.pages.length && !document.referencesText && notices.length < 15)
            notices.push(`${source.sourceKey} 暂无可检查的正文，候选结果未覆盖该资料。`);
          documents.push(document);
        }
        if (ctx.signal?.aborted)
          throw new AppError(409, 'RULES_STOPPED', '当前运行已停止，本次规则检查未完成。');
        const results = runConsistencyRules(documents, selected);
        if (selected.has('R5') && estarCount === 0)
          coverageNotices.push('本批没有可核对的 eSTAR 容器，R5 未执行。');
        if (results.length > 5000)
          coverageNotices.push('候选条目超过分页上限，请按资料组缩小检查范围。');
        const messages = [...coverageNotices, ...notices].slice(0, 16);
        const scanned = sources.map(summary);
        const findings = [];
        for (const finding of results.slice(input.offset, input.offset + input.limit)) {
          const item = {
            ...finding,
            references: finding.references.map(({ key, page, xfa }) => ({
              ...summary(byVersion.get(key)!),
              page,
              locatorKind: xfa ? ('xfa_datasets' as const) : ('document_page' as const),
            })),
          };
          const candidate = {
            ...item,
            findingKey: createHash('sha256').update(JSON.stringify(item)).digest('hex'),
          };
          if (JSON.stringify([scanned, messages, ...findings, candidate]).length > 28_000) break;
          findings.push(candidate);
        }
        if (!findings.length && input.offset < results.length)
          throw new AppError(
            422,
            'RULES_RESULT_LIMIT',
            '当前候选与资料清单超过单页上限，请缩小资料范围后重新检查。',
          );
        const offset = input.offset + findings.length;
        return {
          data: {
            status: 'ok',
            scanned,
            pageCount: pages.length,
            total: results.length,
            findings,
            notices: messages,
            nextOffset:
              findings.length > 0 && offset < results.length && offset <= 5000 ? offset : null,
          },
          dataLevel: highestDocumentLevel(sources.map(({ dataLevel }) => dataLevel)),
        };
      } catch (error) {
        if (!(error instanceof AppError) || !error.code.startsWith('RULES_')) throw error;
        return {
          data: { status: 'unavailable', code: error.code, message: error.message },
          dataLevel: ctx.maxDataLevel,
        };
      }
    },
    async refreshDataLevel(ctx, raw) {
      const proof = rulesRunResultSchema.parse(raw);
      if (proof.status === 'unavailable') return ctx.maxDataLevel;
      const sources = await selectedSources(ctx, proof.scanned);
      if (
        sources.some(
          (source, index) =>
            source.contentSha256 !== proof.scanned[index]?.contentSha256 ||
            source.documentId !== proof.scanned[index]?.documentId ||
            source.version !== proof.scanned[index]?.version,
        )
      )
        throw new AppError(
          409,
          'RULES_RESULT_STALE',
          '已收录资料源或版本发生变化，请重新执行规则检查。',
        );
      return highestDocumentLevel(sources.map(({ dataLevel }) => dataLevel));
    },
  };
}
