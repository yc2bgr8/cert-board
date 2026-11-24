import type { ZodType } from 'zod';

function countFields(value: unknown): number {
  if (Array.isArray(value))
    return value.reduce((total, element) => total + countFields(element), 0);
  if (!value || typeof value !== 'object') return 0;
  const fields = Object.values(value);
  return fields.length + fields.reduce<number>((total, element) => total + countFields(element), 0);
}

export function parseWalkthroughJson<T>(answer: string, schema: ZodType<T>): T | null {
  const text = answer.trim();
  const fenced = /^```(?:json)?\s*\r?\n([\s\S]+?)\r?\n```$/iu.exec(text);
  const payload = fenced?.[1] ?? text;
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) return null;
  // JSON.parse 会覆盖重复键。这里的严格 schema 保留全部允许字段。
  const colon = /\s*:/uy;
  const rawFields = [...payload.matchAll(/"(?:\\[\s\S]|[^"\\])*"/gu)].filter((token) => {
    colon.lastIndex = token.index + token[0].length;
    return colon.test(payload);
  }).length;
  return rawFields === countFields(parsed.data) ? parsed.data : null;
}
