import { createHash } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  officialLookupInputSchema,
  officialLookupResultSchema,
  officialRecordSchema,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { authorize } from '../auth/authorization.js';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import type { FetcherClient } from '../documents/fetcher-client.js';
import {
  archivePublicWebSnapshot,
  cachedPublicWebArchive,
  downloadPublicWebSnapshot,
} from '../documents/public-web.js';
import { normalizeOfficialResponse, officialRequestUrl } from '../official/providers.js';
import type { ToolDefinition, ToolExecutionContext } from './registry.js';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const resultPage = z.strictObject({
  records: z.array(officialRecordSchema).max(25),
  nextOffset: z.number().int().positive().max(1000).nullable(),
});

function createOfficialRateLimit() {
  const buckets = new Map<string, { day: number; used: number; next: number }>();
  return async (host: string, signal?: AbortSignal) => {
    const now = Date.now();
    const day = Math.floor(now / (24 * 60 * 60 * 1000));
    const previous = buckets.get(host);
    const slot = Math.max(now, previous?.next ?? 0);
    const used = previous?.day === day ? previous.used : 0;
    if (slot - now > 3000 || (host === 'api.fda.gov' && used >= 900))
      throw new AppError(
        429,
        'OFFICIAL_RATE_LIMIT',
        '该官方数据源近期查询较多，请稍后重试或使用已存档资料。',
      );
    if (signal?.aborted) throw new AppError(409, 'WEB_STOPPED', '运行已停止，官方请求未发出。');
    buckets.set(host, { day, used: used + 1, next: slot + 1000 });
    if (slot > now) {
      try {
        await wait(slot - now, undefined, { signal });
      } catch {
        throw new AppError(409, 'WEB_STOPPED', '运行已停止，官方请求未发出。');
      }
    }
  };
}

type CheckRequest = (context: ToolExecutionContext, url: string) => Promise<{ projectId: string }>;

export function officialLookupTool(
  pool: Pool,
  store: DocumentBlobStore,
  fetcher: Pick<FetcherClient, 'fetchPage'>,
  checkRequest: CheckRequest,
): ToolDefinition {
  const reserve = createOfficialRateLimit();
  return {
    metadata: {
      name: 'official_lookup',
      version: 'builtin-official-lookup-v1',
      publication: 'published',
      effect: 'read',
      modes: ['read_only', 'ask', 'full'],
      approvalInAsk: false,
      authorizationAction: 'project.read',
      outputDataLevel: 'public',
      description: {
        purpose:
          '按明确编号回查 openFDA、AccessGUDID 或加拿大 MDALL，返回精简记录与可引用的公开存档。',
        whenToUse: '已知公开的 K 号、产品代码、法规条款号、企业注册号、器械标识或加拿大许可编号。',
        avoid:
          '不要传保密或内部编号、患者信息、完整 UDI 中的生产批次或序列号。网页正文使用 web_fetch。',
        parameters:
          'dataset 选择 fda_510k/kNumber、fda_classification/productCode、fda_regulation/regulationNumber、fda_registration/registrationNumber、gudid_device/deviceIdentifier、mdall_company_licences/companyId、mdall_licence/licenceNumber、mdall_device/deviceId、mdall_identifier/deviceIdentifier。可选 asOf 形如 2025-12-31；分页时传回 nextOffset。空列表表示未匹配，查询不可用时公开结果不能代替证据。只读会话可以读取记录，不新建存档。',
        example: { dataset: 'fda_510k', kNumber: 'K170825' },
      },
    },
    inputSchema: officialLookupInputSchema,
    outputSchema: officialLookupResultSchema,
    async execute(ctx, raw) {
      try {
        const input = officialLookupInputSchema.parse(raw);
        const url = officialRequestUrl(input);
        const sourceKey = `O-${sha256(JSON.stringify([input.dataset, url, input.asOf ?? null, input.offset ?? 0]))}`;
        const { projectId } = await checkRequest(ctx, url);
        const readOnly = ctx.permissionMode === 'read_only';
        if (
          !readOnly &&
          (!authorize(ctx.actor, 'document.write', { projectId }) ||
            (ctx.goalId && ctx.goalStatus !== 'active'))
        )
          throw new AppError(
            403,
            'WEB_ARCHIVE_FORBIDDEN',
            '当前项目或目标不允许登记官方资料存档。',
          );
        if (!readOnly)
          await ctx.tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            `${projectId}:${sourceKey}`,
          ]);
        const current = await cachedPublicWebArchive(ctx.tx, projectId, url, sourceKey);
        if (current && !current.placeholder && current.text) {
          const page = resultPage.safeParse(JSON.parse(current.text));
          if (page.success)
            return {
              data: {
                status: 'ok',
                ...page.data,
                ...(input.asOf ? { asOf: input.asOf } : {}),
                fetchedAt: current.archive.fetchedAt,
                cached: true,
                evidence: {
                  documentId: current.documentId,
                  version: current.version,
                  page: 1,
                  sourceKey,
                  archive: current.archive,
                },
              },
              dataLevel: 'public',
            };
        }
        await reserve(new URL(url).hostname, ctx.signal);
        await checkRequest(ctx, url);
        const downloaded = await downloadPublicWebSnapshot(fetcher, url, ctx.signal);
        if (downloaded.snapshot.mediaType !== 'application/json')
          throw new AppError(
            502,
            'OFFICIAL_RESPONSE_INVALID',
            '官方服务未返回 JSON，请检查数据源后重试。',
          );
        const page = normalizeOfficialResponse(
          input,
          JSON.parse(downloaded.bytes.toString('utf8')),
        );
        let evidence = null;
        if (!readOnly) {
          const text = JSON.stringify(page, null, 2);
          const bytes = input.asOf ? Buffer.from(text) : downloaded.bytes;
          await ctx.tx.query('SAVEPOINT official_archive_write');
          try {
            const { saved, archive } = await archivePublicWebSnapshot(
              pool,
              store,
              ctx.tx,
              projectId,
              {
                bytes,
                snapshot: {
                  ...downloaded.snapshot,
                  title: `官方编号回查 ${input.dataset}`,
                  sha256: input.asOf ? sha256(bytes) : downloaded.snapshot.sha256,
                  bodyBase64: bytes.toString('base64'),
                  text,
                  truncated: false,
                },
              },
              'official',
              sourceKey,
            );
            evidence = {
              documentId: saved.documentId,
              version: saved.version,
              page: 1,
              sourceKey,
              archive,
            };
            await ctx.tx.query('RELEASE SAVEPOINT official_archive_write');
          } catch (error) {
            await ctx.tx.query('ROLLBACK TO SAVEPOINT official_archive_write');
            await ctx.tx.query('RELEASE SAVEPOINT official_archive_write');
            if (error instanceof AppError && error.code === 'DOCUMENT_VOIDED') throw error;
            throw new AppError(
              503,
              'OFFICIAL_ARCHIVE_FAILED',
              '官方记录没有完成存档，请检查资料存储后重试。',
            );
          }
        }
        return {
          data: {
            status: 'ok',
            ...page,
            fetchedAt: downloaded.snapshot.fetchedAt,
            ...(input.asOf ? { asOf: input.asOf } : {}),
            evidence,
            cached: false,
          },
          dataLevel: 'public',
        };
      } catch (failure) {
        const error =
          failure instanceof z.ZodError || failure instanceof SyntaxError
            ? new AppError(
                502,
                'OFFICIAL_RESPONSE_INVALID',
                '官方记录格式无法核对，请核对编号或换用已存档原件。',
              )
            : failure;
        if (
          error instanceof AppError &&
          /^(?:OFFICIAL_|WEB_|FETCH_|FETCHER_|EXTERNAL_|DOCUMENT_VOIDED$)/u.test(error.code)
        )
          return {
            data: { status: 'unavailable', code: error.code, message: error.message },
            dataLevel: 'public',
          };
        throw error;
      }
    },
  };
}
