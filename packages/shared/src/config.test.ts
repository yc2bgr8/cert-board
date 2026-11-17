import { expect, test } from 'vitest';
import { ConfigurationError, parseBackendConfig } from './config.js';

const environment = {
  DATABASE_URL: 'postgresql://test:example@127.0.0.1:25432/cert_board',
  TEST_DATABASE_URL: 'postgresql://test:example@127.0.0.1:25432/cert_board_test',
  MINIO_ENDPOINT: '127.0.0.1',
  MINIO_ROOT_USER: 'fixture',
  MINIO_ROOT_PASSWORD: 'fixture-password-only',
};

test('配置默认端口正确且false字符串不会变成true', () => {
  expect(parseBackendConfig({ ...environment, MINIO_USE_SSL: 'false' })).toMatchObject({
    PORT: 28081,
    HOST: '127.0.0.1',
    MINIO_USE_SSL: false,
  });
});

test('缺失配置说明变量名，不包含传入的秘密', () => {
  expect(() => parseBackendConfig({ DATABASE_URL: 'private-sensitive-value' })).toThrow(
    ConfigurationError,
  );
  try {
    parseBackendConfig({ DATABASE_URL: 'private-sensitive-value' });
  } catch (error) {
    expect(String(error)).toContain('DATABASE_URL');
    expect(String(error)).not.toContain('private-sensitive-value');
  }
});

test('拒绝日常库作为测试库及错误数据库协议', () => {
  expect(() =>
    parseBackendConfig({ ...environment, TEST_DATABASE_URL: environment.DATABASE_URL }),
  ).toThrow();
  expect(() =>
    parseBackendConfig({ ...environment, DATABASE_URL: 'https://example.com/db' }),
  ).toThrow();
  expect(() => parseBackendConfig({ ...environment, HOST: '0.0.0.0' })).toThrow();
});

test('数据库主机别名和编码差异不能绕过测试库隔离', () => {
  expect(() =>
    parseBackendConfig({
      ...environment,
      DATABASE_URL: 'postgresql://test:example@localhost:25432/cert%5Fboard_test',
    }),
  ).toThrow(ConfigurationError);
});
