import { expect, test, vi } from 'vitest';
import type { AgentIdentity } from '@cert-board/shared';
import { searchDocuments, type DocumentReadDatabase } from './service.js';

vi.mock('../projects/service.js', () => ({ getProject: vi.fn() }));
const id = '10000000-0000-4000-8000-000000000001';
const actor: AgentIdentity = {
  kind: 'agent',
  userId: id,
  runId: id,
  username: 'zhangsan',
  displayName: '张三',
  isDevelopment: true,
  isManagement: false,
};
async function snippet(text: string, query: string) {
  const database = {
    query: vi
      .fn()
      .mockResolvedValue({
        rows: [
          {
            documentId: id,
            sourceKey: 'SOURCE',
            name: '510(k) summary',
            version: 1,
            page: 1,
            locatorKind: 'physical_page',
            dataLevel: 'internal',
            method: 'text',
            ocrScore: null,
            pageText: text,
          },
        ],
      }),
  } as unknown as DocumentReadDatabase;
  return (await searchDocuments(database, actor, id, { query })).items[0]!;
}
test('检索返回服务器实际摘要起点，UTF-16偏移可准确还原原文且不落在半个字符', async () => {
  const original = `${'🙂'.repeat(70)} predicate device is described here. ${'z'.repeat(400)}`;
  const result = await snippet(original, 'predicate device');
  expect('snippetOffset' in result).toBe(true);
  if (!('snippetOffset' in result)) return;
  const offset = Number(result.snippetOffset);
  expect(offset).toBe(62);
  expect(original.slice(offset, offset + result.snippet.length)).toBe(result.snippet);
  expect(result.snippet).toContain('predicate device');
  expect(result.snippet.length).toBeLessThanOrEqual(300);
  expect(original.charCodeAt(offset) >= 0xdc00 && original.charCodeAt(offset) <= 0xdfff).toBe(
    false,
  );
});
test('仅资料名匹配时摘要起点为0，不把查询页游标当作正文偏移', async () => {
  const original = '原文中的编号必须实际阅读后才可引用。';
  const result = await snippet(original, '510(k) summary');
  expect('snippetOffset' in result).toBe(true);
  if (!('snippetOffset' in result)) return;
  expect(result.snippetOffset).toBe(0);
  expect(result.snippet).toBe(original);
});
