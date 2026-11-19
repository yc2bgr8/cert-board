// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { LinkedVerificationHistoryActions } from './LinkedVerifications.js';

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
