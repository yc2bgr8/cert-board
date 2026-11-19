import { z } from 'zod';

const privateSuffixes = [
  '.localhost',
  '.local',
  '.internal',
  '.invalid',
  '.test',
  '.example',
  '.onion',
  '.home.arpa',
];
const publicHostname = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/u;
const credentialParameter =
  /^(?:(?:xamz|xgoog|xoss|awsaccess|googleaccess).+|.*(?:apikey|token|credential|signature|password|sessionid|secret)|auth|authorization|bearer|code|key|policy|sig|session|jwt)$/u;
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const date = z.string().datetime({ offset: true });

export function hasWebControlCharacters(value: string) {
  return Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

export function canonicalPublicWebUrl(value: string) {
  if (
    value.length > 2048 ||
    /[\s\\]/u.test(value) ||
    hasWebControlCharacters(value) ||
    !URL.canParse(value)
  )
    return null;
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hostname.length > 253 ||
    !publicHostname.test(url.hostname) ||
    privateSuffixes.some((suffix) => url.hostname.endsWith(suffix))
  )
    return null;
  try {
    const decoded = decodeURIComponent(url.pathname + url.search);
    if (hasWebControlCharacters(decoded) || decoded.includes('\\')) return null;
    const parameters = Array.from(url.searchParams.keys());
    if (
      url.search.split('&').length > 64 ||
      url.search.includes(';') ||
      parameters.some((key) =>
        credentialParameter.test(key.trim().toLowerCase().replace(/[-_]/gu, '')),
      )
    )
      return null;
  } catch {
    return null;
  }
  url.hash = '';
  if (!url.search) url.search = '';
  return url.href.length <= 2048 ? url.href : null;
}

const webUrl = z
  .string()
  .refine((value) => canonicalPublicWebUrl(value) === value, '需要规范的公开 HTTPS 地址。');
export const webSourceTypeSchema = z.enum(['official', 'extended', 'general']);
export const webMediaTypeSchema = z.enum([
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'application/json',
  'application/pdf',
]);
export const webArchiveInfoSchema = z
  .object({
    url: webUrl,
    sourceType: webSourceTypeSchema,
    fetchedAt: date,
    mediaType: webMediaTypeSchema,
    sha256: hash,
    extractedTruncated: z.boolean(),
  })
  .strict();
export type WebArchiveInfo = z.infer<typeof webArchiveInfoSchema>;

export const webFetchInputSchema = z.object({ url: z.string().trim().min(1).max(2048) }).strict();
export const webSearchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(1000),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict();
export const fetcherSnapshotSchema = z
  .object({
    url: webUrl,
    title: z.string().min(1).max(255),
    text: z.string().max(64000),
    truncated: z.boolean(),
    mediaType: webMediaTypeSchema,
    fetchedAt: date,
    sha256: hash,
    bodyBase64: z
      .string()
      .max(2796204)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/u)
      .refine((value) => value.length % 4 === 0),
  })
  .strict();
const searchResult = z
  .object({
    title: z.string().min(1).max(255),
    url: z.string().transform((value, ctx) => {
      const canonical = canonicalPublicWebUrl(value);
      if (canonical !== null) return canonical;
      ctx.addIssue({ code: 'custom', message: '需要可核对的公开 HTTPS 地址。' });
      return z.NEVER;
    }),
    snippet: z.string().max(500),
  })
  .strict();
export const fetcherSearchResultSchema = z
  .object({ items: z.array(searchResult).max(10) })
  .strict();
const unavailable = z
  .object({
    status: z.literal('unavailable'),
    code: z.string().regex(/^[A-Z0-9_]{1,80}$/u),
    message: z.string().min(1).max(400),
    nextUrl: webUrl.optional(),
  })
  .strict();
const searchSuccess = z
  .object({
    items: z.array(searchResult.extend({ sourceType: webSourceTypeSchema })).max(10),
    redactions: z.number().int().nonnegative(),
    source: z.literal('searxng'),
  })
  .strict();
const fetchSuccess = z
  .object({
    archive: webArchiveInfoSchema,
    documentId: z.string().uuid(),
    version: z.number().int().positive(),
    sourceKey: z.string().max(128),
    title: z.string().max(255),
    preview: z.string().max(4000),
    cached: z.boolean(),
    page: z.literal(1).nullable(),
    guidance: z.string().max(400).optional(),
  })
  .strict();
const readOnlyFetch = z
  .object({
    status: z.literal('read_only'),
    url: webUrl,
    sourceType: webSourceTypeSchema,
    title: z.string().max(255),
    preview: z.string().max(4000),
    truncated: z.boolean(),
    guidance: z.string().max(400),
  })
  .strict();
export const webSearchResultSchema = z.union([searchSuccess, unavailable]);
export const webFetchResultSchema = z.union([fetchSuccess, readOnlyFetch, unavailable]);
