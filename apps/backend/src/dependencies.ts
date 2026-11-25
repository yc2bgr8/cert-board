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
  // pg-pool 只代理池内空闲连接的错误。租出的连接在两条查询之间也可能断开。
  database.on('connect', (client) => client.on('error', () => undefined));
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
