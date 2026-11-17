import { AppError } from '../api/errors.js';

type Attempts = { failures: number; expiresAt: number };

export class LoginLimiter {
  private readonly entries = new Map<string, Attempts>();
  constructor(
    private readonly now = () => Date.now(),
    private readonly limit = 5,
    private readonly windowMs = 15 * 60 * 1_000,
    private readonly capacity = 10_000,
  ) {}

  private cleanExpired() {
    const now = this.now();
    for (const [key, attempt] of this.entries)
      if (attempt.expiresAt <= now) this.entries.delete(key);
  }

  assertAllowed(key: string) {
    this.cleanExpired();
    const attempt = this.entries.get(key);
    if (
      (attempt && attempt.failures >= this.limit) ||
      (!attempt && this.entries.size >= this.capacity)
    ) {
      throw new AppError(429, 'LOGIN_RATE_LIMITED', '登录尝试过于频繁，请15分钟后重试。');
    }
  }

  recordFailure(key: string) {
    this.cleanExpired();
    const previous = this.entries.get(key);
    if (previous) previous.failures++;
    else if (this.entries.size < this.capacity) {
      this.entries.set(key, { failures: 1, expiresAt: this.now() + this.windowMs });
    }
  }

  reset(key: string) {
    this.entries.delete(key);
  }
}
