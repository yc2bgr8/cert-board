import { describe, expect, test, vi } from 'vitest';
import type { Pool } from 'pg';
import { parseSeedEnvironment, SeedConfigurationError } from '@cert-board/shared';
import { seedDevelopmentAccounts } from './seed.js';

const configuration = {
  NODE_ENV: 'test',
  DEV_RA_PASSWORD: 'ra-unit-test-123456789',
  DEV_RB_PASSWORD: 'rb-unit-test-123456789',
  DEV_GM_PASSWORD: 'gm-unit-test-123456789',
  DEV_SALES_PASSWORD: 'sales-unit-test-123456789',
  DEV_TECH_PASSWORD: 'tech-unit-test-123456789',
};

describe('开发账号种子边界', () => {
  test('生产环境拒绝且不连接数据库', async () => {
    const connect = vi.fn();
    const pool = { connect } as unknown as Pool;
    await expect(
      seedDevelopmentAccounts(pool, { ...configuration, NODE_ENV: 'production' }),
    ).rejects.toBeInstanceOf(SeedConfigurationError);
    expect(connect).not.toHaveBeenCalled();
  });

  test('缺少环境声明或密码、短密码及全空白密码均拒绝', () => {
    for (const change of [
      { NODE_ENV: undefined },
      { DEV_RA_PASSWORD: undefined },
      { DEV_RA_PASSWORD: 'short' },
      { DEV_RA_PASSWORD: ' '.repeat(32) },
    ])
      expect(() => parseSeedEnvironment({ ...configuration, ...change })).toThrow(
        SeedConfigurationError,
      );
  });

  test('配置错误只含变量名，不包含输入密码', () => {
    const password = 'short-secret';
    try {
      parseSeedEnvironment({ ...configuration, DEV_RA_PASSWORD: password });
      throw new Error('应拒绝弱密码');
    } catch (error) {
      expect(error).toBeInstanceOf(SeedConfigurationError);
      expect((error as Error).message).toContain('DEV_RA_PASSWORD');
      expect((error as Error).message).not.toContain(password);
    }
  });

  test('有效配置仅保留开发所需字段', () => {
    const result = parseSeedEnvironment({ ...configuration, OPENROUTER_API_KEY: 'discard-me' });
    expect(result).toEqual(configuration);
  });
});
