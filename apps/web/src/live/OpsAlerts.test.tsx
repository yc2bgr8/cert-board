// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { OpsAlerts } from './OpsAlerts.js';

const { opsAlerts } = vi.hoisted(() => ({ opsAlerts: vi.fn() }));
vi.mock('./api.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./api.js')>();
  return { ...real, api: { ...real.api, opsAlerts } };
});

let client: QueryClient | undefined;
afterEach(() => {
  cleanup();
  client?.clear();
  opsAlerts.mockReset();
});

function show() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpsAlerts userId="synthetic-operator" />
    </QueryClientProvider>,
  );
}

test('即使缓存的服务器结果说未过期，也按最后检查时间识别过期', async () => {
  opsAlerts.mockResolvedValue({
    checkedAt: new Date(Date.now() - 240_000).toISOString(),
    stale: false,
    alerts: [],
  });
  show();
  expect((await screen.findByRole('alert')).textContent).toContain('未更新检查结果');
  expect(screen.queryByText('没有活跃告警。')).toBeNull();
});

test('较早确认的告警保留上次检查时间并显示当前不可验证', async () => {
  const seen = new Date(Date.now() - 90_000).toISOString();
  opsAlerts.mockResolvedValue({
    checkedAt: new Date().toISOString(),
    stale: false,
    alerts: [
      {
        key: 'service_sandbox',
        level: 'critical',
        detail: '代码沙箱不可用。',
        openedAt: seen,
        lastSeenAt: seen,
      },
    ],
  });
  show();
  expect(await screen.findByText(/当前信号未验证/u)).toBeDefined();
  expect(screen.queryByRole('alert')).toBeNull();
});
