import { afterEach, describe, expect, test, vi } from 'vitest';
import { parseBackendConfig } from '@cert-board/shared';
import { createApp } from './app.js';
import type { HealthDependencies } from './dependencies.js';
import { AppError } from './api/errors.js';

const config = parseBackendConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:25432/cert_board',
  TEST_DATABASE_URL: 'postgresql://test:test@127.0.0.1:25432/cert_board_test',
  MINIO_ENDPOINT: '127.0.0.1',
  MINIO_ROOT_USER: 'unit-test-user',
  MINIO_ROOT_PASSWORD: 'unit-test-placeholder-password',
});
const apps: ReturnType<typeof createApp>[] = [];
const dependencies = (): HealthDependencies => ({
  checkDatabase: vi.fn().mockResolvedValue(undefined),
  checkStorage: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
});
const appFor = (deps = dependencies()) => {
  const app = createApp(config, deps);
  apps.push(app);
  return app;
};
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('接口服务基础', () => {
  test('已定义的授权错误保留正确状态和安全提示', async () => {
    const app = appFor();
    app.get('/test-forbidden', () => {
      throw new AppError(403, 'FORBIDDEN', '没有访问权限。');
    });
    const response = await app.inject('/test-forbidden');
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toMatchObject({ code: 'FORBIDDEN', message: '没有访问权限。' });
  });
  test('工作区冲突只返回有界的路径清单，不把内容写进错误', async () => {
    const app = appFor();
    app.get('/test-conflict', () => {
      throw new AppError(409, 'WORKSPACE_CONFLICT', '请核对差异后重试。', {
        changedPaths: ['交付/记录.md'],
        truncated: false,
      });
    });
    const response = await app.inject('/test-conflict');
    expect(response.statusCode).toBe(409);
    expect(response.json().error.details).toEqual({
      changedPaths: ['交付/记录.md'],
      truncated: false,
    });
  });
  test('健康检查实际调用两个依赖检查', async () => {
    const deps = dependencies();
    const response = await appFor(deps).inject('/health');
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('same-origin');
    expect(response.json()).toEqual({
      status: 'ok',
      dependencies: { database: 'up', storage: 'up' },
    });
    expect(deps.checkDatabase).toHaveBeenCalledOnce();
    expect(deps.checkStorage).toHaveBeenCalledOnce();
  });

  test('依赖故障返回503且不泄露底层异常', async () => {
    const deps = dependencies();
    deps.checkDatabase = vi
      .fn()
      .mockRejectedValue(new Error('postgresql://user:secret@db/service'));
    const response = await appFor(deps).inject('/health');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'degraded',
      dependencies: { database: 'down', storage: 'up' },
    });
    expect(response.body).not.toContain('secret');
    expect(response.body).not.toContain('postgresql');
  });

  test('未知接口返回一致的中文错误，不回显路径', async () => {
    const response = await appFor().inject('/private?token=example');
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: '没有找到该接口，请检查地址。',
        requestId: expect.any(String),
      },
    });
    expect(response.body).not.toContain('example');
  });

  test('请求解析错误不回显输入或凭据', async () => {
    const response = await appFor().inject({
      method: 'POST',
      url: '/health',
      headers: { 'content-type': 'application/json' },
      payload: '{"password":"example-secret"',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(response.body).not.toContain('example-secret');
  });

  test('内部错误统一返回安全消息', async () => {
    const app = appFor();
    app.get('/test-error', () => {
      throw new Error('凭据=example-secret');
    });
    const response = await app.inject('/test-error');
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toContain('example-secret');
  });

  test('关闭服务时关闭依赖连接', async () => {
    const deps = dependencies();
    const app = appFor(deps);
    await app.ready();
    await app.close();
    expect(deps.close).toHaveBeenCalledOnce();
  });
});
