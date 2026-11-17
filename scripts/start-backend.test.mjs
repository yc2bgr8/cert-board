import { expect, test } from 'vitest';
import { backendEnvironment } from './start-backend.mjs';

const local = {
  DATABASE_URL: 'database-connection',
  MINIO_ROOT_PASSWORD: 'storage-placeholder',
  DEV_RA_PASSWORD: 'browser-password-placeholder',
  OPENROUTER_API_KEY: 'model-placeholder',
  HTTPS_PROXY: 'http://127.0.0.1:28085',
  UNRELATED_SECRET: 'unrelated-placeholder',
};
const inherited = {
  PATH: 'node-tools',
  GITHUB_TOKEN: 'inherited-placeholder',
  DEV_TECH_PASSWORD: 'inherited-browser-password',
};

test('API不取得模型密钥、开发账号密码或宿主机其他令牌', () => {
  const env = backendEnvironment('api', local, inherited);
  expect(env).toEqual({
    PATH: 'node-tools',
    DATABASE_URL: 'database-connection',
    MINIO_ROOT_PASSWORD: 'storage-placeholder',
  });
});

test('worker只取得模型网关所需密钥，不取得浏览器登录凭据', () => {
  const env = backendEnvironment('worker', local, inherited);
  expect(env.OPENROUTER_API_KEY).toBe('model-placeholder');
  expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:28085');
  for (const key of ['DEV_RA_PASSWORD', 'DEV_TECH_PASSWORD', 'GITHUB_TOKEN', 'UNRELATED_SECRET'])
    expect(env[key]).toBeUndefined();
});

test('拒绝任意入口', () => {
  expect(() => backendEnvironment('shell', local, inherited)).toThrow('仅支持');
});
