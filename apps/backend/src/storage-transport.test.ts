import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from 'vitest';
import { createStorageTransport } from './storage-transport.js';

test('文件存储不响应时主动销毁请求，连接不会无限等待', async () => {
  const server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const transport = createStorageTransport(false, 50);
    const result = await new Promise<{ error: Error; destroyed: boolean }>((resolve) => {
      const request = transport.request({ hostname: '127.0.0.1', port, path: '/' });
      request.on('error', (error) => resolve({ error, destroyed: request.destroyed }));
      request.end();
    });
    expect(result.error.message).toBe('文件存储连接超时');
    expect(result.destroyed).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
