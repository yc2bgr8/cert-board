import { expect, test, vi } from 'vitest';
import { createOfficialRateLimit } from './official-lookup.js';

test('授权并发顺序变化时，按实际发出时间限制同一官方主机', async () => {
  const attempt = createOfficialRateLimit();
  let release!: () => void;
  const firstAuthorized = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispatch = async () => performance.now();
  const delayed = attempt('api.fda.gov', undefined, () => firstAuthorized, dispatch);
  const firstSent = await attempt('api.fda.gov', undefined, async () => undefined, dispatch);
  release();
  expect((await delayed) - firstSent).toBeGreaterThanOrEqual(990);
});

test('授权完成时主机已空闲，旧的排队截止时间不拒绝派发', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(0);
  try {
    const attempt = createOfficialRateLimit();
    let release!: () => void;
    const authorization = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = async () => '已派发';
    const pending = attempt('api.fda.gov', undefined, () => authorization, send);
    now.mockReturnValue(4_000);
    await attempt('api.fda.gov', undefined, async () => undefined, send);
    now.mockReturnValue(6_000);
    release();
    await expect(pending).resolves.toBe('已派发');
  } finally {
    now.mockRestore();
  }
});
