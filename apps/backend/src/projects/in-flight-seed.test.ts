import { expect, test } from 'vitest';
import { requireInFlightSeedTarget } from './in-flight-seed.js';

const isolated = {
  NODE_ENV: 'development',
  CONTAINER_RUNTIME: 'host',
  DATABASE_URL: 'postgresql://127.0.0.1:25432/cert_board',
  MINIO_ENDPOINT: '127.0.0.1',
  MINIO_PORT: 29000,
  MINIO_USE_SSL: false,
  MINIO_BUCKET: 'cert-board',
} as const;

test('初始化只接受验收机的指定数据库与文件存储组合', () => {
  expect(() => requireInFlightSeedTarget(isolated, true)).not.toThrow();
  expect(() => requireInFlightSeedTarget(isolated, false)).toThrow('独立验收机');
  for (const patch of [
    { NODE_ENV: 'production' },
    { DATABASE_URL: 'postgresql://127.0.0.1:25432/workbench' },
    { DATABASE_URL: 'postgresql://database.example.invalid:25432/cert_board' },
    { MINIO_ENDPOINT: 'store.example.invalid' },
    { MINIO_BUCKET: 'workbench' },
  ] as const) {
    expect(() => requireInFlightSeedTarget({ ...isolated, ...patch }, true)).toThrow('独立验收机');
  }
});
