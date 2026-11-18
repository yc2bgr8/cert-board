import { ProxyAgent, request } from 'undici';

type Target = { baseUrl: string; apiKeyEnv: string };
type Options = {
  proxyUrl: string;
  allowedHosts: readonly string[];
  environment?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

export class GatewayTransportError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus?: number,
    public readonly usage?: Record<string, unknown>,
  ) {
    super('模型上游请求未完成，请检查代理或服务状态；未输出原始错误、请求或凭据。');
    this.name = 'GatewayTransportError';
  }
}

/** 错误只携带有限数字用量，让上层仍能结算已知费用，不携带任何原始错误文本。 */
function usageMetadata(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || !('usage' in raw)) return undefined;
  const source = raw.usage;
  if (!source || typeof source !== 'object') return undefined;
  const data = source as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'cost']) {
    if (typeof data[key] === 'number' && Number.isFinite(data[key])) result[key] = data[key];
  }
  if (
    typeof data.cost === 'string' &&
    data.cost.length <= 80 &&
    /^\d+(?:\.\d+)?(?:e[+-]?\d{1,2})?$/i.test(data.cost)
  )
    result.cost = data.cost;
  const details = data.prompt_tokens_details;
  if (
    details &&
    typeof details === 'object' &&
    'cached_tokens' in details &&
    typeof details.cached_tokens === 'number' &&
    Number.isFinite(details.cached_tokens)
  ) {
    result.prompt_tokens_details = { cached_tokens: details.cached_tokens };
  }
  return Object.keys(result).length ? result : undefined;
}

export class RealGatewayTransport {
  readonly kind = 'real' as const;
  #dispatcher: ProxyAgent;
  #hosts: Set<string>;
  #credential: (name: string) => string | undefined;
  #timeout: number;
  #responseLimit: number;

  constructor(options: Options) {
    let proxy: URL;
    try {
      proxy = new URL(options.proxyUrl);
    } catch {
      throw new GatewayTransportError('MODEL_PROXY_INVALID');
    }
    if (
      proxy.protocol !== 'http:' ||
      proxy.hostname !== '127.0.0.1' ||
      proxy.port !== '28085' ||
      proxy.username ||
      proxy.password ||
      proxy.pathname !== '/' ||
      proxy.search ||
      proxy.hash
    )
      throw new GatewayTransportError('MODEL_PROXY_INVALID');
    if (
      !options.allowedHosts.length ||
      options.allowedHosts.some((host) => !/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/.test(host))
    )
      throw new GatewayTransportError('MODEL_ALLOWLIST_INVALID');
    this.#hosts = new Set(options.allowedHosts);
    this.#timeout = options.timeoutMs ?? 60_000;
    this.#responseLimit = options.maxResponseBytes ?? 4 * 1024 * 1024;
    if (
      !Number.isInteger(this.#timeout) ||
      this.#timeout < 1 ||
      this.#timeout > 120_000 ||
      !Number.isInteger(this.#responseLimit) ||
      this.#responseLimit < 1 ||
      this.#responseLimit > 8 * 1024 * 1024
    )
      throw new GatewayTransportError('MODEL_TRANSPORT_LIMIT_INVALID');
    const environment = options.environment ?? process.env;
    this.#credential = (name) => environment[name];
    // 显式dispatcher不读取NO_PROXY，不存在失败直连回退；上游TLS仍必须正常校验证书。
    this.#dispatcher = new ProxyAgent({
      uri: proxy.href,
      requestTls: { rejectUnauthorized: true },
    });
  }

  async send(model: Target, body: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.#call(model, 'chat/completions', body, signal);
  }

  /** 公开模型目录用于价格核对；仍经同一代理，不需要发送API key。 */
  async catalog(model: Target, signal?: AbortSignal): Promise<unknown> {
    return this.#call(model, 'models', undefined, signal);
  }

  async #call(
    model: Target,
    endpoint: 'chat/completions' | 'models',
    body: unknown,
    signal?: AbortSignal,
  ) {
    let base: URL;
    try {
      base = new URL(model.baseUrl);
    } catch {
      throw new GatewayTransportError('MODEL_UPSTREAM_INVALID');
    }
    if (
      base.protocol !== 'https:' ||
      !this.#hosts.has(base.hostname) ||
      (base.port && base.port !== '443') ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new GatewayTransportError('MODEL_UPSTREAM_INVALID');
    if (signal?.aborted) throw new GatewayTransportError('MODEL_ABORTED');
    const headers: Record<string, string> = { accept: 'application/json' };
    let serialized: string | undefined;
    if (endpoint === 'chat/completions') {
      if (!/^[A-Z][A-Z0-9_]{1,79}$/.test(model.apiKeyEnv))
        throw new GatewayTransportError('MODEL_CREDENTIAL_INVALID');
      const credential = this.#credential(model.apiKeyEnv);
      if (!credential || /[\r\n]/.test(credential))
        throw new GatewayTransportError('MODEL_CREDENTIAL_MISSING');
      try {
        serialized = JSON.stringify(body);
      } catch {
        throw new GatewayTransportError('MODEL_REQUEST_INVALID');
      }
      if (!serialized || Buffer.byteLength(serialized, 'utf8') > 262_144)
        throw new GatewayTransportError('MODEL_REQUEST_TOO_LARGE');
      headers.authorization = `Bearer ${credential}`;
      headers['content-type'] = 'application/json';
    }
    const combined = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(this.#timeout)])
      : AbortSignal.timeout(this.#timeout);
    try {
      const response = await request(`${base.href.replace(/\/+$/, '')}/${endpoint}`, {
        method: endpoint === 'models' ? 'GET' : 'POST',
        headers,
        ...(serialized === undefined ? {} : { body: serialized }),
        dispatcher: this.#dispatcher,
        signal: combined,
        headersTimeout: this.#timeout,
        bodyTimeout: this.#timeout,
        idempotent: false,
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += data.length;
        if (bytes > this.#responseLimit) {
          response.body.destroy();
          throw new GatewayTransportError('MODEL_RESPONSE_TOO_LARGE', response.statusCode);
        }
        chunks.push(data);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new GatewayTransportError(
          response.statusCode >= 200 && response.statusCode < 300
            ? 'MODEL_RESPONSE_INVALID'
            : 'MODEL_HTTP_ERROR',
          response.statusCode,
        );
      }
      if (response.statusCode < 200 || response.statusCode >= 300)
        throw new GatewayTransportError(
          'MODEL_HTTP_ERROR',
          response.statusCode,
          usageMetadata(parsed),
        );
      if (
        !String(response.headers['content-type'] ?? '')
          .toLowerCase()
          .includes('application/json')
      )
        throw new GatewayTransportError(
          'MODEL_RESPONSE_INVALID',
          response.statusCode,
          usageMetadata(parsed),
        );
      return parsed;
    } catch (error) {
      if (error instanceof GatewayTransportError) throw error;
      throw new GatewayTransportError(
        signal?.aborted
          ? 'MODEL_ABORTED'
          : combined.aborted
            ? 'MODEL_TIMEOUT'
            : 'MODEL_TRANSPORT_FAILED',
      );
    }
  }

  async close() {
    await this.#dispatcher.close();
  }
}
