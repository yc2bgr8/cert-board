import type { Pool } from 'pg';
import {
  canonicalPublicWebUrl,
  hasWebControlCharacters,
  webFetchInputSchema,
  webFetchResultSchema,
  webSearchInputSchema,
  webSearchResultSchema,
  type WebArchiveInfo,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { authorize } from '../auth/authorization.js';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import { FetcherRedirect, type FetcherClient } from '../documents/fetcher-client.js';
import {
  archivePublicWebSnapshot,
  cachedPublicWebArchive,
  classifyWebSource,
  downloadPublicWebSnapshot,
  webSourceKey,
} from '../documents/public-web.js';
import { redactExternalMessages } from '../external-model/policy.js';
import { ExternalModels } from '../external-model/service.js';
import { officialLookupTool } from './official-lookup.js';
import type { ToolDefinition, ToolExecutionContext } from './registry.js';

const maxCalls = 8;
const preview = (value: string) => value.slice(0, 4000).replace(/[\uD800-\uDBFF]$/u, '');
const archiveGuidance = (archive: WebArchiveInfo, placeholder: boolean) =>
  placeholder
    ? '原件已存档。解析文字暂不可用，请由人在证据页下载原件核对。'
    : archive.extractedTruncated
      ? '仅存入提取上限内的正文。doc_read 可分页读完已提取部分，剩余内容请人工核对存档原件。'
      : undefined;

async function webResult(action: () => Promise<unknown>) {
  try {
    return { data: await action(), dataLevel: 'public' as const };
  } catch (error) {
    if (
      error instanceof AppError &&
      /^(?:WEB_|FETCH_|FETCHER_|SEARCH_|EXTERNAL_|DOCUMENT_VOIDED$)/u.test(error.code)
    )
      return {
        data: {
          status: 'unavailable',
          code: error.code,
          message: error.message,
          ...(error instanceof FetcherRedirect && error.nextUrl ? { nextUrl: error.nextUrl } : {}),
        },
        dataLevel: 'public' as const,
      };
    throw error;
  }
}

export function buildWebTools(
  pool: Pool,
  store: DocumentBlobStore,
  fetcher: Pick<FetcherClient, 'fetchPage' | 'search'>,
  extendedHosts: readonly string[] = [],
): ToolDefinition[] {
  const protection = new ExternalModels(pool, undefined, undefined, 20_000_000_000n);
  const classify = (url: string) => classifyWebSource(url, extendedHosts);

  function readOnlyPreview(url: string, title: string, text: string, extractedTruncated: boolean) {
    const truncated = extractedTruncated || text.length > 4000;
    return {
      status: 'read_only',
      url,
      sourceType: classify(url),
      title,
      preview: preview(text),
      truncated,
      guidance: truncated
        ? '预览已截断。可切换到可写模式后重新抓取，通过 doc_read 继续读取已提取正文，或由人下载原件核对。'
        : '只读会话只提供临时预览。需要可引用的存档时，请切换到可写模式后重新抓取。',
    };
  }

  async function protect(ctx: ToolExecutionContext, content: string, address: boolean) {
    if (!ctx.projectId)
      throw new AppError(409, 'WEB_PROJECT_REQUIRED', '请先进入项目再使用网页工具。');
    const restricted = await ctx.tx.query(
      `SELECT 1 FROM document d JOIN document_version v ON v.document_id=d.id
       WHERE d.project_id=$1 AND v.data_level='confidential' LIMIT 1`,
      [ctx.projectId],
    );
    if (ctx.maxDataLevel === 'confidential' || restricted.rowCount)
      throw new AppError(
        403,
        'WEB_CONFIDENTIAL_BLOCKED',
        '当前项目或对话包含保密资料，请改用项目内资料。',
      );
    const calls = await ctx.tx.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM tool_invocation
       WHERE run_id=$1 AND tool_name IN ('web_search','web_fetch','official_lookup')`,
      [ctx.runId],
    );
    if ((calls.rows[0]?.count ?? 0) > maxCalls)
      throw new AppError(409, 'WEB_LIMIT_REACHED', '本轮网页操作已达八次，请使用现有存档继续。');
    const words = (await protection.words(ctx.tx)).map(({ phrase }) => phrase);
    const source = address ? `${content}\n${decodeURIComponent(content)}` : content;
    const sanitized = redactExternalMessages([{ role: 'user', content: source }], words);
    if (address && sanitized.replacementCount)
      throw new AppError(
        403,
        'WEB_ADDRESS_REJECTED',
        '网址含已登记的保密信息，请改用无需这些信息的公开网址。',
      );
    await protection.checkConfidentialSources(ctx.tx, sanitized.messages);
    if (ctx.signal?.aborted) throw new AppError(409, 'WEB_STOPPED', '运行已停止，网页请求未发出。');
    return {
      projectId: ctx.projectId,
      content: address ? content : sanitized.messages[0]!.content,
      redactions: sanitized.replacementCount,
    };
  }

  const search: ToolDefinition = {
    metadata: {
      name: 'web_search',
      version: 'builtin-web-search-v1',
      publication: 'published',
      effect: 'read',
      modes: ['read_only', 'ask', 'full'],
      approvalInAsk: false,
      outputDataLevel: 'public',
      authorizationAction: 'project.read',
      description: {
        purpose: '检索公开网页，返回有限摘要、网址和来源类别。网页内容只作为待核实资料。',
        whenToUse: '已经知道要查的主题，但缺少公开的网址。',
        avoid: '已有公开网址用 web_fetch。不要输入密钥、保密原文或需要发送给外部收件人的内容。',
        parameters: 'query 为一行简短检索词。limit 默认 5，最多 10 条。',
        example: { query: 'FDA 510(k) submission guidance', limit: 4 },
      },
    },
    inputSchema: webSearchInputSchema,
    outputSchema: webSearchResultSchema,
    execute: (ctx, raw) =>
      webResult(async () => {
        const input = webSearchInputSchema.parse(raw);
        if (hasWebControlCharacters(input.query))
          throw new AppError(400, 'WEB_QUERY_INVALID', '请输入不含控制字符的一行检索词。');
        const prepared = await protect(ctx, input.query, false);
        const result = await fetcher.search(prepared.content, input.limit, ctx.signal);
        return {
          items: result.items.map((item) => ({ ...item, sourceType: classify(item.url) })),
          redactions: prepared.redactions,
          source: 'searxng',
        };
      }),
  };

  const fetchPage: ToolDefinition = {
    metadata: {
      name: 'web_fetch',
      version: 'builtin-web-fetch-v1',
      publication: 'published',
      effect: 'read',
      modes: ['read_only', 'ask', 'full'],
      approvalInAsk: false,
      outputDataLevel: 'public',
      authorizationAction: 'project.read',
      description: {
        purpose: '读取公开 HTTPS 页面或原件。可写会话返回存档定位，只读会话只返回临时预览。',
        whenToUse: '要核对公开原文或保存可追溯网页，已有公开 HTTPS 地址。',
        avoid:
          '没有公开网址时先用 web_search。引用时对返回的资料版本再调用 doc_read，不能把摘要或未解析 PDF 当作原文。',
        parameters: 'url 为公开 HTTPS 页面、纯文本、JSON 或 PDF 的地址，不带凭据。',
        example: { url: 'https://www.fda.gov/medical-devices' },
      },
    },
    inputSchema: webFetchInputSchema,
    outputSchema: webFetchResultSchema,
    execute: (ctx, raw) =>
      webResult(async () => {
        const url = canonicalPublicWebUrl(webFetchInputSchema.parse(raw).url);
        if (!url)
          throw new AppError(400, 'WEB_URL_INVALID', '请提供不含凭据的公开 HTTPS 域名地址。');
        const { projectId } = await protect(ctx, url, true);
        const readOnly = ctx.permissionMode === 'read_only';
        if (
          !readOnly &&
          (!authorize(ctx.actor, 'document.write', { projectId }) ||
            (ctx.goalId && ctx.goalStatus !== 'active'))
        )
          throw new AppError(403, 'WEB_ARCHIVE_FORBIDDEN', '当前项目或目标不允许登记网页存档。');
        const sourceKey = webSourceKey(url);
        if (!readOnly)
          await ctx.tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            `${projectId}:${sourceKey}`,
          ]);
        const current = await cachedPublicWebArchive(ctx.tx, projectId, url);
        if (current) {
          if (readOnly)
            return readOnlyPreview(
              url,
              current.title,
              current.text ?? '',
              current.archive.extractedTruncated,
            );
          const guidance = archiveGuidance(current.archive, current.placeholder);
          return {
            archive: current.archive,
            documentId: current.documentId,
            version: current.version,
            sourceKey,
            title: current.title,
            preview: preview(current.text ?? ''),
            cached: true,
            page: current.placeholder ? null : 1,
            ...(guidance ? { guidance } : {}),
          };
        }
        await protect(ctx, url, true);
        const downloaded = await downloadPublicWebSnapshot(fetcher, url, ctx.signal);
        const { snapshot } = downloaded;
        if (readOnly)
          return readOnlyPreview(url, snapshot.title, snapshot.text, snapshot.truncated);
        await ctx.tx.query('SAVEPOINT web_archive_write');
        try {
          const { archive, saved, placeholder } = await archivePublicWebSnapshot(
            pool,
            store,
            ctx.tx,
            projectId,
            downloaded,
            classify(url),
          );
          await ctx.tx.query('RELEASE SAVEPOINT web_archive_write');
          const guidance = archiveGuidance(archive, placeholder);
          return {
            archive,
            documentId: saved.documentId,
            version: saved.version,
            sourceKey,
            title: snapshot.title,
            preview: preview(snapshot.text),
            cached: false,
            page: placeholder ? null : 1,
            ...(guidance ? { guidance } : {}),
          };
        } catch (error) {
          await ctx.tx.query('ROLLBACK TO SAVEPOINT web_archive_write');
          await ctx.tx.query('RELEASE SAVEPOINT web_archive_write');
          if (error instanceof AppError && error.code === 'DOCUMENT_VOIDED') throw error;
          throw new AppError(
            503,
            'WEB_ARCHIVE_WRITE_FAILED',
            '本轮网页存档未完成，请核对资料存储后重试。',
          );
        }
      }),
  };

  return [search, fetchPage, officialLookupTool(pool, store, fetcher, (ctx, url) => protect(ctx, url, true))];
}
