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

test('仅明确的容器运行配置可申请绑定容器网卡', () => {
  expect(
    parseBackendConfig({ ...environment, CONTAINER_RUNTIME: 'docker', HOST: '0.0.0.0' }),
  ).toMatchObject({ CONTAINER_RUNTIME: 'docker', HOST: '0.0.0.0' });
  expect(() =>
    parseBackendConfig({ ...environment, CONTAINER_RUNTIME: 'docker', HOST: '192.0.2.5' }),
  ).toThrow('HOST');
});

test('隔离部署使用指定回环验收来源，生产与宿主仍拒绝该开发端口', () => {
  const WEB_ORIGIN = 'http://127.0.0.1:28186';
  expect(
    parseBackendConfig({ ...environment, CONTAINER_RUNTIME: 'docker', WEB_ORIGIN }).WEB_ORIGIN,
  ).toBe(WEB_ORIGIN);
  expect(() => parseBackendConfig({ ...environment, WEB_ORIGIN })).toThrow('WEB_ORIGIN');
  expect(() =>
    parseBackendConfig({
      ...environment,
      CONTAINER_RUNTIME: 'docker',
      NODE_ENV: 'production',
      WEB_ORIGIN,
    }),
  ).toThrow('WEB_ORIGIN');
});

test('会话配置限制可信来源，生产环境必须使用HTTPS', () => {
  expect(() =>
    parseBackendConfig({ ...environment, WEB_ORIGIN: 'http://untrusted.example' }),
  ).toThrow(ConfigurationError);
  expect(() => parseBackendConfig({ ...environment, NODE_ENV: 'production' })).toThrow(
    ConfigurationError,
  );
  expect(
    parseBackendConfig({
      ...environment,
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://127.0.0.1:28080',
    }).SESSION_TTL_HOURS,
  ).toBe(12);
});
test('隔离浏览器验收可用单独的回环端口，开发与生产继续校验原有来源', () => {
  expect(
    parseBackendConfig({ ...environment, NODE_ENV: 'test', WEB_ORIGIN: 'http://127.0.0.1:28180' })
      .WEB_ORIGIN,
  ).toBe('http://127.0.0.1:28180');
  expect(() =>
    parseBackendConfig({ ...environment, WEB_ORIGIN: 'http://127.0.0.1:28180' }),
  ).toThrow('WEB_ORIGIN');
  expect(() =>
    parseBackendConfig({
      ...environment,
      NODE_ENV: 'test',
      WEB_ORIGIN: 'http://example.invalid:28180',
    }),
  ).toThrow('WEB_ORIGIN');
});
