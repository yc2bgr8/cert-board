import { beforeEach, expect, test, vi } from 'vitest';
const stub = vi.hoisted(() => ({ request: vi.fn(), proxies: [] as unknown[] }));
vi.mock('undici', () => ({
  request: stub.request,
  ProxyAgent: class {
    constructor(options: unknown) {
      stub.proxies.push(options);
    }
    async close() {}
  },
}));
import { GatewayTransportError, RealGatewayTransport } from './transport.js';

const model = { baseUrl: 'https://model.example/api/v1', apiKeyEnv: 'MODEL_API_KEY' };
const options = {
  proxyUrl: 'http://127.0.0.1:28085',
  allowedHosts: ['model.example'],
  environment: { MODEL_API_KEY: 'synthetic-model-token', NO_PROXY: '*' },
};
function response(value: unknown, statusCode = 200, contentType = 'application/json') {
  return {
    statusCode,
    headers: { 'content-type': contentType },
    body: {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify(value));
      },
      destroy: vi.fn(),
    },
  };
}
beforeEach(() => {
  stub.request.mockReset();
  stub.proxies.length = 0;
});

test('请求固定经过显式代理，NO_PROXY不能改为直连，也不自动重试', async () => {
  stub.request.mockResolvedValue(response({ ok: true }));
  const transport = new RealGatewayTransport(options);
  expect(await transport.send(model, { messages: [] })).toEqual({ ok: true });
  expect(stub.proxies).toEqual([
    { uri: 'http://127.0.0.1:28085/', requestTls: { rejectUnauthorized: true } },
  ]);
  const [url, sent] = stub.request.mock.calls[0]!;
  expect(url).toBe('https://model.example/api/v1/chat/completions');
  expect(Boolean(sent.dispatcher)).toBe(true);
  expect(sent.idempotent).toBe(false);
  expect(sent.headers.authorization).toBe('Bearer synthetic-model-token');
  stub.request.mockRejectedValue(new Error('raw private failure'));
  await expect(transport.send(model, {})).rejects.toMatchObject({ code: 'MODEL_TRANSPORT_FAILED' });
  expect(stub.request.mock.calls.length).toBe(2);
  await transport.close();
});

test('拒绝任意代理、非白名单主机、IP、非TLS和包含凭据的URL', async () => {
  for (const proxyUrl of [
    'http://remote.example:28085',
    'http://127.0.0.1:9999',
    'http://user:pass@127.0.0.1:28085',
  ])
    expect(() => new RealGatewayTransport({ ...options, proxyUrl })).toThrow(GatewayTransportError);
  const transport = new RealGatewayTransport(options);
  for (const baseUrl of [
    'http://model.example/api/v1',
    'https://other.example/api',
    'https://127.0.0.1/api',
    'https://user:pass@model.example/api',
    'https://model.example/api?token=synthetic',
  ])
    await expect(transport.send({ ...model, baseUrl }, {})).rejects.toMatchObject({
      code: 'MODEL_UPSTREAM_INVALID',
    });
  expect(stub.request.mock.calls.length).toBe(0);
});

test('重定向不会跟随；HTTP错误只带安全用量，不带正文或请求头', async () => {
  const usage = {
    prompt_tokens: 20,
    completion_tokens: 5,
    total_tokens: 25,
    cost: 0.01,
    prompt_tokens_details: { cached_tokens: 3, secret: 'never-return-this' },
    raw: 'never-return-this',
  };
  stub.request.mockResolvedValue(
    response(
      {
        usage,
        error: { message: 'never-return-this' },
        headers: { authorization: 'never-return-this' },
      },
      429,
    ),
  );
  const transport = new RealGatewayTransport(options);
  let failure: unknown;
  try {
    await transport.send(model, {});
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    code: 'MODEL_HTTP_ERROR',
    httpStatus: 429,
    usage: {
      prompt_tokens: 20,
      completion_tokens: 5,
      total_tokens: 25,
      cost: 0.01,
      prompt_tokens_details: { cached_tokens: 3 },
    },
  });
  expect(JSON.stringify(failure)).not.toContain('never-return-this');
  stub.request.mockResolvedValue(response({}, 302));
  await expect(transport.send(model, {})).rejects.toMatchObject({
    code: 'MODEL_HTTP_ERROR',
    httpStatus: 302,
  });
  expect(stub.request.mock.calls.length).toBe(2);
});

test('输入输出有字节上限，公开目录不发送凭据', async () => {
  const transport = new RealGatewayTransport({ ...options, maxResponseBytes: 32 });
  await expect(transport.send(model, { body: 'a'.repeat(262145) })).rejects.toMatchObject({
    code: 'MODEL_REQUEST_TOO_LARGE',
  });
  expect(stub.request.mock.calls.length).toBe(0);
  stub.request.mockResolvedValue(response({ body: 'a'.repeat(100) }));
  await expect(transport.send(model, {})).rejects.toMatchObject({
    code: 'MODEL_RESPONSE_TOO_LARGE',
  });
  stub.request.mockResolvedValue(response({ data: [] }));
  await transport.catalog(model);
  const [, sent] = stub.request.mock.calls[1]!;
  expect(sent.headers.authorization).toBeUndefined();
  expect(sent.method).toBe('GET');
});

test.each(['0.015', '1.5e-2'])('HTTP错误保留合法数字字符串费用%s，不丢已知账目', async (cost) => {
  stub.request.mockResolvedValue(
    response({ usage: { prompt_tokens: 1, completion_tokens: 1, cost } }, 502),
  );
  const transport = new RealGatewayTransport(options);
  await expect(transport.send(model, {})).rejects.toMatchObject({
    code: 'MODEL_HTTP_ERROR',
    usage: { cost },
  });
  stub.request.mockResolvedValue(
    response({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: 'private-body' } }, 502),
  );
  let failure: unknown;
  try {
    await transport.send(model, {});
  } catch (error) {
    failure = error;
  }
  expect(JSON.stringify(failure)).not.toContain('private-body');
});

test('取消立即传入正在执行的调用，底层异常不泄露', async () => {
  stub.request.mockImplementation(
    (_url, sent) =>
      new Promise((_resolve, reject) => {
        sent.signal.addEventListener('abort', () => reject(new Error('private underlying error')), {
          once: true,
        });
      }),
  );
  const transport = new RealGatewayTransport(options);
  const controller = new AbortController();
  const pending = transport.send(model, {}, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'MODEL_ABORTED' });
  expect(stub.request.mock.calls.length).toBe(1);
  await expect(transport.send(model, {}, controller.signal)).rejects.toMatchObject({
    code: 'MODEL_ABORTED',
  });
  expect(stub.request.mock.calls.length).toBe(1);
});
