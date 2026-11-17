import { expect, test } from 'vitest';
import { LoginLimiter } from './login-limiter.js';

test('达到失败上限拒绝，窗口过后恢复，重试不能推迟期限', () => {
  let now = 0;
  const limiter = new LoginLimiter(() => now, 2, 1000);
  limiter.recordFailure('user');
  limiter.assertAllowed('user');
  limiter.recordFailure('user');
  expect(() => limiter.assertAllowed('user')).toThrow('登录尝试过于频繁');
  now = 1001;
  expect(() => limiter.assertAllowed('user')).not.toThrow();
});

test('成功登录重置且容量上限时保守拒绝新的身份', () => {
  const limiter = new LoginLimiter(() => 0, 2, 1000, 1);
  limiter.recordFailure('a');
  expect(() => limiter.assertAllowed('b')).toThrow('登录尝试过于频繁');
  limiter.reset('a');
  expect(() => limiter.assertAllowed('b')).not.toThrow();
});
