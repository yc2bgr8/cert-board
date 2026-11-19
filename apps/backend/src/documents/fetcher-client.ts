import { z } from 'zod';
import {
  canonicalPublicWebUrl,
  fetcherSearchResultSchema,
  fetcherSnapshotSchema,
  type BackendConfig,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';

const maxResponse = 3_400_000;
const timeoutMs = 14_000;
const failureMessages: Record<string, string> = {
  FETCH_REDIRECT: '站点返回跳转。请先核对公开 HTTPS 最终网址，再重新提交。',
  FETCH_MEDIA_UNSUPPORTED: '当前可存档 HTML、纯文本、JSON 和 PDF。请改用页面正文或可下载原件。',
  FETCH_BODY_TOO_LARGE: '网页响应超过存档大小上限，请改用更小的公开页面或原件。',
  FETCH_BODY_INCOMPLETE: '站点提前断开，未收到完整原件。请重新抓取或改用其他来源。',
  FETCH_TIMEOUT: '网页请求超过总时限。请重试或改用其他公开来源。',
  FETCH_UPSTREAM_STATUS: '公开网站没有返回成功响应，请检查当前网址或换用可信来源。',
  FETCH_DESTINATION_REJECTED: '目标不是可访问的公开域名，请改用公开 HTTPS 地址。',
  FETCH_PROXY_UNAVAILABLE: '抓取代理未能建立公开连接，请核对域名、证书或代理状态。',
  SEARCH_PROVIDER_UNAVAILABLE: '检索服务暂不可用。已有公开地址时，可以使用 web_fetch。',
  SEARCH_PROVIDER_INVALID: '检索服务返回格式有误，请改用已知公开地址。',
};

export class FetcherRedirect extends AppError {
  constructor(public readonly nextUrl: string | null) {
    super(409, 'FETCH_REDIRECT', failureMessages.FETCH_REDIRECT!);
  }
}

export class FetcherClient {
  private readonly address: string;

  constructor(address: string, runtime: BackendConfig['CONTAINER_RUNTIME']) {
    const expected = runtime === 'docker' ? 'http://fetch-relay:28084/' : 'http://127.0.0.1:28084/';
    if (!URL.canParse(address) || new URL(address).href !== expected)
      throw new AppError(500, 'FETCHER_CONFIG_INVALID', '抓取服务只能使用本部署的固定内部地址。');
    this.address = expected;
  }

  fetchPage(url: string, signal?: AbortSignal) {
    return this.request('fetch', { url }, fetcherSnapshotSchema, signal);
  }

  search(query: string, limit: number, signal?: AbortSignal) {
    return this.request('search', { query, limit }, fetcherSearchResultSchema, signal);
  }

  private async request<T>(
    path: 'fetch' | 'search',
    body: unknown,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetch(new URL(path, this.address), {
        method: 'POST',
        redirect: 'error',
        signal: combined,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      });
      const declared = Number(response.headers.get('content-length'));
      if (!response.body || declared > maxResponse) {
        await response.body?.cancel();
        throw new AppError(
          502,
          'FETCHER_RESPONSE_INVALID',
          '抓取服务回复不符合格式或超过长度上限。',
        );
      }
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > maxResponse)
            throw new AppError(502, 'FETCHER_RESPONSE_INVALID', '抓取服务回复超过长度上限。');
          chunks.push(Buffer.from(part.value));
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok) {
        const failure = z
          .object({ code: z.string().max(80), nextUrl: z.string().max(2048).nullable().optional() })
          .safeParse(raw);
        const code = failure.success ? failure.data.code : '';
        if (code === 'FETCH_REDIRECT') {
          const candidate = failure.success ? failure.data.nextUrl : null;
          throw new FetcherRedirect(candidate ? canonicalPublicWebUrl(candidate) : null);
        }
        if (Object.hasOwn(failureMessages, code))
          throw new AppError(response.status, code, failureMessages[code]!);
        throw new AppError(
          502,
          'FETCHER_REQUEST_FAILED',
          '抓取服务拒绝了请求，请检查公开网址或检索条件。',
        );
      }
      const result = schema.safeParse(raw);
      if (!result.success)
        throw new AppError(502, 'FETCHER_RESPONSE_INVALID', '抓取或检索回复不符合存档格式。');
      return result.data;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        503,
        'FETCHER_UNAVAILABLE',
        '抓取服务未能完成请求，请检查本地服务后重试。',
      );
    }
  }
}
