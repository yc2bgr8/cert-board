import { expect, test } from 'vitest';
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
