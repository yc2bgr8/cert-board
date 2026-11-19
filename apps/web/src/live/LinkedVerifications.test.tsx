// @vitest-environment jsdom
import { randomUUID } from 'node:crypto';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { verificationLinkListSchema } from '@cert-board/shared';
import { LinkedVerificationHistoryActions, LinkedVerificationRows } from './LinkedVerifications.js';

afterEach(cleanup);

test('旧核实分页失败后重试下一页，实时刷新期间等待', () => {
  const query = {
    isError: true,
    isFetchNextPageError: true,
    isFetching: true,
    hasNextPage: true,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
  };
  const actions = render(<LinkedVerificationHistoryActions query={query} />);
  const button = screen.getByRole('button', { name: '重试读取更早的核实' });
  fireEvent.click(button);
  expect(query.fetchNextPage).not.toHaveBeenCalled();
  actions.rerender(<LinkedVerificationHistoryActions query={{ ...query, isFetching: false }} />);
  fireEvent.click(button);
  expect(query.fetchNextPage).toHaveBeenCalledWith({ cancelRefetch: false });
  expect(query.refetch).not.toHaveBeenCalled();
});

test('审核卡只打开已核对的站内原文，待核实出处没有证据入口', () => {
  const documentId = randomUUID();
  const items = verificationLinkListSchema.parse([
    {
      room: {
        id: randomUUID(),
        projectId: randomUUID(),
        projectName: '合成项目',
        host: 'registration',
        title: '出处核实',
        startedBy: '张三',
        status: 'completed',
        activeModel: null,
        stoppedBy: null,
        humanJoined: false,
        updatedAt: '2026-11-20T00:00:00Z',
      },
      result: 'available',
      summary: '可信 1 项，待核实 1 项。',
      counts: { trusted: 1, disputed: 0, unverified: 1, human: 0 },
      sources: [
        {
          title: '已核对的出处',
          url: 'https://www.fda.gov/public',
          excerpt: '逐字原文',
          check: { status: 'verified', documentId, version: 2, page: 1, sha256: 'a'.repeat(64) },
        },
        {
          title: '不符的出处',
          url: 'https://www.fda.gov/mismatch',
          check: { status: 'excerpt_mismatch' },
        },
      ],
    },
  ]);
  const open = vi.fn();
  const openEvidence = vi.fn();
  render(<LinkedVerificationRows items={items} open={open} openEvidence={openEvidence} inReview />);
  fireEvent.click(screen.getByRole('button', { name: '已核对的出处 · 查看存档原文' }));
  expect(openEvidence).toHaveBeenCalledWith([
    { documentId, version: 2, page: 1, quote: '逐字原文' },
  ]);
  expect(screen.queryByText(/不符的出处/u)).toBeNull();
  expect(screen.getByText('待核实 1')).toBeTruthy();
  expect(screen.queryByRole('link')).toBeNull();
});
