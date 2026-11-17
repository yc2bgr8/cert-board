import { expect, test } from 'vitest';
import { parseBackendConfig } from '@cert-board/shared';
import { createLogger, sanitizeLogValue } from './logger.js';

test('递归隐藏认证头、cookie、秘密字段和数组', () => {
  const safe = sanitizeLogValue({
    authorization: 'bad',
    cookie: 'bad',
    nested: {
      API_KEY: 'bad',
      access_TOKEN: 'bad',
      client_SECRET: 'bad',
      password: 'bad',
      list: [{ OPENROUTER_API_KEY: 'bad' }],
      normal: 'ok',
    },
  });
  expect(JSON.stringify(safe)).not.toContain('bad');
  expect(JSON.stringify(safe)).toContain('ok');
});

test('实际pino输出不包含连接凭据、秘密消息和异常正文', () => {
  const output: string[] = [];
  const config = parseBackendConfig({
    DATABASE_URL: 'postgresql://test:private-db@127.0.0.1/cert_board',
    TEST_DATABASE_URL: 'postgresql://test:private-db@127.0.0.1/cert_board_test',
    MINIO_ENDPOINT: '127.0.0.1',
    MINIO_ROOT_USER: 'fixture',
    MINIO_ROOT_PASSWORD: 'fixture-storage-password',
  });
  const logger = createLogger(config, {
    write: (line) => {
      output.push(line);
    },
  });
  logger.info(
    {
      credential: config.MINIO_ROOT_PASSWORD,
      err: new Error('hidden-body'),
      URL: config.DATABASE_URL,
    },
    'private-db',
  );
  expect(output).toHaveLength(1);
  for (const secret of ['private-db', 'fixture-storage-password', 'hidden-body'])
    expect(output[0]).not.toContain(secret);
});

test('循环和深层对象不会使日志失败', () => {
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  expect(sanitizeLogValue(cycle)).toEqual({ self: '[已省略]' });
});

test('子日志绑定与后续绑定中的秘密同样被隐藏', () => {
  const output: string[] = [];
  const config = parseBackendConfig({
    DATABASE_URL: 'postgresql://test:private-db@127.0.0.1/cert_board',
    TEST_DATABASE_URL: 'postgresql://test:private-db@127.0.0.1/cert_board_test',
    MINIO_ENDPOINT: '127.0.0.1',
    MINIO_ROOT_USER: 'fixture',
    MINIO_ROOT_PASSWORD: 'fixture-storage-password',
  });
  const logger = createLogger(config, {
    write: (line) => {
      output.push(line);
    },
  });
  const child = logger.child({
    authorization: 'bound-authorization',
    nested: { API_KEY: 'bound-api-key' },
  });
  child.setBindings({ cookie: 'bound-cookie' });
  child.info('普通事件');
  expect(output.join('')).not.toContain('bound-');
});
