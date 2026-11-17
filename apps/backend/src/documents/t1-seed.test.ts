import { expect, test } from 'vitest';
import { readT1Fixture } from './t1-seed.js';

test('T1快照完整且主路径两处摘录确实逐字存在', async () => {
  const fixture = await readT1Fixture();
  expect(fixture.documents).toHaveLength(59);
  expect(fixture.pages).toHaveLength(664);
  expect(
    fixture.pages
      .find((p) => p.doc === 'D035' && p.page === 1)
      ?.text.includes('510(k) Number: K170825'),
  ).toBe(true);
  expect(
    fixture.pages
      .find((p) => p.doc === 'D035' && p.page === 5)
      ?.text.includes('510(K) number K170285'),
  ).toBe(true);
  expect(
    fixture.pages
      .find((p) => p.doc === 'D014')
      ?.text.trimStart()
      .startsWith('Please wait...'),
  ).toBe(true);
  expect(fixture.snapshot).toMatch(/^[0-9a-f]{64}$/);
});
