import { expect, test } from 'vitest';
import { linkedVerificationDeadline } from './linked-verification.js';

test('相对于队列领取时刻使用同一截止时间，并为后续处理保留一分钟', () => {
  const minute = 60_000;
  const startedAt = 42 * minute;
  const expiresAt = startedAt + 15 * minute;

  expect(linkedVerificationDeadline(startedAt, expiresAt)).toEqual({
    deadline: startedAt + 10 * minute,
    limitedByQueue: false,
  });
  const afterSixMinutes = startedAt + 6 * minute;
  expect(linkedVerificationDeadline(afterSixMinutes, expiresAt)).toEqual({
    deadline: afterSixMinutes + 8 * minute,
    limitedByQueue: true,
  });
  expect(linkedVerificationDeadline(expiresAt - 30_000, expiresAt).deadline).toBe(
    expiresAt - minute,
  );
  expect(linkedVerificationDeadline(startedAt)).toEqual({
    deadline: startedAt + 10 * minute,
    limitedByQueue: false,
  });
});
