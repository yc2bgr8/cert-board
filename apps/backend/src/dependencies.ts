import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { Client } from 'minio';
import pg from 'pg';
import type { BackendConfig } from '@cert-board/shared';
import { createDatabase } from './db/client.js';
import { createStorageTransport } from './storage-transport.js';

export interface HealthDependencies {
  checkDatabase(): Promise<void>;
  checkStorage(): Promise<void>;
  close(): Promise<void>;
}

export function createDependencies(config: BackendConfig) {
  const database = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 5_000,
    application_name: 'cert-board',
  });
  // 空闲连接断开不应触发未处理异常；健康检查负责报告依赖不可用。
  database.on('error', () => undefined);
  const transportAgent = config.MINIO_USE_SSL
    ? new HttpsAgent({ keepAlive: true, timeout: 5_000 })
    : new HttpAgent({ keepAlive: true, timeout: 5_000 });
  const storage = new Client({
    endPoint: config.MINIO_ENDPOINT,
    port: config.MINIO_PORT,
    useSSL: config.MINIO_USE_SSL,
    accessKey: config.MINIO_ROOT_USER,
    secretKey: config.MINIO_ROOT_PASSWORD,
    transportAgent,
    transport: createStorageTransport(config.MINIO_USE_SSL),
  });
  let closing: Promise<void> | undefined;
  return {
    database,
    orm: createDatabase(database),
    storage,
    async checkDatabase() {
      await database.query('SELECT 1');
    },
    async checkStorage() {
      await storage.listBuckets();
    },
    close() {
      transportAgent.destroy();
      closing ??= database.end();
      return closing;
    },
  };
}
