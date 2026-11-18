import { expect, test } from 'vitest';
import { docReadToolInputSchema, docSearchToolInputSchema } from './document-tools.js';
import { documentPageReadOptionsSchema } from './documents.js';
test('读取工具仅接受实际资料UUID及分页，不接受项目切换或来源编号替代', () => {
  const input = { id: '10000000-0000-4000-8000-000000000001', version: 1, page: 1 };
  expect(docReadToolInputSchema.parse(input)).toEqual({ ...input, offset: 0, limit: 1800 });
  expect(docReadToolInputSchema.parse({ ...input, limit: 12000 }).limit).toBe(12000);
  expect(documentPageReadOptionsSchema.parse({}).limit).toBe(8000);
  for (const change of [
    { id: 'D001' },
    { projectId: input.id },
    { path: '.env.local' },
    { limit: 12001 },
    { offset: -1 },
  ])
    expect(docReadToolInputSchema.safeParse({ ...input, ...change }).success).toBe(false);
});
test('检索输入分页有界且不能选择其他项目', () => {
  expect(docSearchToolInputSchema.parse({ query: 'predicate' })).toEqual({
    query: 'predicate',
    offset: 0,
    limit: 10,
  });
  expect(
    docSearchToolInputSchema.safeParse({ query: 'predicate', projectId: 'untrusted' }).success,
  ).toBe(false);
  expect(docSearchToolInputSchema.safeParse({ query: '', limit: 30 }).success).toBe(false);
  expect(docSearchToolInputSchema.safeParse({ query: 'K', limit: 31 }).success).toBe(false);
});
