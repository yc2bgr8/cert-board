// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { api } from './api.js';
import { KnowledgeReviews } from './KnowledgeReviews.js';

vi.mock('./api.js', () => ({
  api: { knowledgeReview: vi.fn(), knowledgeReviews: vi.fn() },
  createRequestKey: vi.fn(),
  errorMessage: String,
}));

test('从待我处理打开不在首页的指定审核卡并将焦点移到卡片', async () => {
  const current = {
    id: '10000000-0000-4000-8000-000000000050',
    kind: 'template' as const,
    title: '合成指定模板',
    code: 'synthetic_focused_template',
    version: '1.0.0',
    status: 'pending' as const,
    contentSha256: 'a'.repeat(64),
    createdAt: '2026-11-27T00:00:00.000Z',
    reviewedAt: null,
    reason: null,
  };
  vi.mocked(api.knowledgeReviews).mockResolvedValue({
    items: [{ ...current, id: '10000000-0000-4000-8000-000000000051', title: '合成首页模板' }],
    nextAfterId: null,
  });
  vi.mocked(api.knowledgeReview).mockResolvedValue({
    ...current,
    draft: {
      kind: 'template',
      content: {
        title: current.title,
        code: current.code,
        version: current.version,
        source: '合成审阅场景',
        body: '合成模板',
        dataLevel: 'internal',
      },
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <KnowledgeReviews userId="member" management={false} focusId={current.id} />
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { name: '合成指定模板 1.0.0' });
  const picker = screen.getByRole<HTMLSelectElement>('combobox', { name: '审核卡' });
  await waitFor(() => expect(picker.value).toBe(current.id));
  expect(document.activeElement).toBe(screen.getByRole('article', { name: '知识审核卡' }));
  expect(vi.mocked(api.knowledgeReview).mock.calls.map(([id]) => id)).toEqual([current.id]);
});
