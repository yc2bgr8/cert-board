import { beforeEach, expect, test, vi } from 'vitest';
import { documentSearchResultSchema } from '@cert-board/shared';
import { searchDocuments } from '../documents/service.js';
import { docSearchTool } from './doc-search.js';
import type { ToolExecutionContext } from './registry.js';

vi.mock('../documents/service.js', () => ({ searchDocuments: vi.fn(), getDocument: vi.fn() }));
const id = '10000000-0000-4000-8000-000000000001';
const ctx = {
  projectId: id,
  tx: { query: vi.fn() },
  actor: { userId: id },
} as unknown as ToolExecutionContext;
beforeEach(() => vi.clearAllMocks());
test.each(['escaped', 'unicode'] as const)(
  '%s大结果缩页而不截断摘要，并给出精确续读位置',
  async (kind) => {
    const items = Array.from({ length: 30 }, (_, index) => ({
      documentId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      sourceKey: `SOURCE${index}`.padEnd(128, 'X'),
      name: (kind === 'escaped' ? '"' : '名').repeat(255),
      version: 1,
      page: 1,
      locatorKind: 'physical_page' as const,
      dataLevel: 'internal' as const,
      snippetOffset: index * 300,
      snippet: (kind === 'escaped' ? '"' : '字').repeat(300),
      method: 'text' as const,
      ocrScore: null,
    }));
    const source = { items, hasMore: false, nextOffset: null };
    vi.mocked(searchDocuments).mockResolvedValue(source);
    const result = await docSearchTool().execute!(ctx, { query: 'word', offset: 7, limit: 30 });
    const output = documentSearchResultSchema.parse(result.data);
    expect(output.items.length).toBeGreaterThan(0);
    expect(output.items.length).toBeLessThan(30);
    expect(output.hasMore).toBe(true);
    expect(output.nextOffset).toBe(7 + output.items.length);
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(30000);
    expect(Buffer.byteLength(JSON.stringify(output), 'utf8')).toBeLessThanOrEqual(56000);
    expect(output.items[0]?.snippet).toBe(items[0]?.snippet);
    expect(output.items.map((item) => item.snippetOffset)).toEqual(
      items.slice(0, output.items.length).map((item) => item.snippetOffset),
    );
    expect(source.items).toHaveLength(30);
    expect(searchDocuments).toHaveBeenCalledWith(ctx.tx, ctx.actor, id, {
      query: 'word',
      offset: 7,
      limit: 30,
    });
  },
);
test('无命中保持完整空结果和最低内部级别', async () => {
  vi.mocked(searchDocuments).mockResolvedValue({ items: [], hasMore: false, nextOffset: null });
  const result = await docSearchTool().execute!(ctx, { query: 'missing' });
  expect(result.data).toEqual({ items: [], hasMore: false, nextOffset: null });
  expect(result.dataLevel).toBe('internal');
});
