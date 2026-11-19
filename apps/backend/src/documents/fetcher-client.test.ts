import { afterEach, expect, test, vi } from 'vitest';
import { canonicalPublicWebUrl } from '@cert-board/shared';
import { FetcherClient } from './fetcher-client.js';

const address = 'https://www.fda.gov/guides/[public]?item=%27known%27';
const client = new FetcherClient('http://127.0.0.1:28084', 'host');

afterEach(() => vi.unstubAllGlobals());

test('网址查询字段上限包含空分隔符，与抓取服务一致', () => {
  const valid = `${address.split('?')[0]}?${'&'.repeat(63)}item=1`;
  const invalid = `${address.split('?')[0]}?${'&'.repeat(64)}item=1`;
  expect(canonicalPublicWebUrl(valid)).toBe(valid);
  expect(canonicalPublicWebUrl(invalid)).toBeNull();
});

test('抓取客户端收到含方括号的规范地址与 UTF-16 边界内容', async () => {
  const text = '😀'.repeat(32_000);
  const snapshot = {
    url: address,
    text,
    title: '公开页面',
    mediaType: 'text/html',
    truncated: true,
    bodyBase64: '',
    sha256: 'a'.repeat(64),
    fetchedAt: '2026-11-20T00:00:00.000Z',
  };
  const transport = vi.fn().mockResolvedValue(Response.json(snapshot));
  vi.stubGlobal('fetch', transport);
  expect(canonicalPublicWebUrl(address)).toBe(address);
  expect(await client.fetchPage(address)).toEqual(snapshot);
  expect(transport).toHaveBeenCalledWith(
    new URL('http://127.0.0.1:28084/fetch'),
    expect.objectContaining({ redirect: 'error', body: JSON.stringify({ url: address }) }),
  );
});

test('检索接受由抓取服务给出的 URL 和字符边界', async () => {
  const result = {
    items: [{ url: address, title: '😀'.repeat(100), snippet: '😀'.repeat(250) }],
  };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(result)));
  expect(await client.search('public question', 5)).toEqual(result);
});

test.each([
  [address, address],
  ['https://www.fda.gov/file?%58-Amz-Signature=fixture', null],
  ['https://127.0.0.1/', null],
])('重定向候选地址独立校验，抓取客户端只请求一次', async (candidate, nextUrl) => {
  const transport = vi
    .fn()
    .mockResolvedValue(
      Response.json({ code: 'FETCH_REDIRECT', nextUrl: candidate }, { status: 409 }),
    );
  vi.stubGlobal('fetch', transport);
  await expect(client.fetchPage(address)).rejects.toMatchObject({
    code: 'FETCH_REDIRECT',
    nextUrl,
  });
  expect(transport).toHaveBeenCalledOnce();
});
