import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Client } from 'minio';
import { expect, test, vi } from 'vitest';
import { BlobStore } from './blob-store.js';

function memoryStorage() {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    bucketExists: vi.fn().mockResolvedValue(false),
    makeBucket: vi.fn().mockResolvedValue(undefined),
    setBucketPolicy: vi.fn().mockResolvedValue(undefined),
    statObject: vi.fn(async (_bucket: string, key: string) => {
      const content = objects.get(key);
      if (!content) throw Object.assign(new Error('未找到测试对象'), { code: 'NoSuchKey' });
      return { size: content.byteLength };
    }),
    putObject: vi.fn(async (_bucket: string, key: string, content: Buffer) => {
      objects.set(key, content);
    }),
    getObject: vi.fn(async (_bucket: string, key: string) => {
      const content = objects.get(key);
      if (!content) throw Object.assign(new Error('未找到测试对象'), { code: 'NoSuchKey' });
      return Readable.from([content]);
    }),
  };
}

test('内容SHA由程序计算，相同内容仅保存同一对象且桶私有', async () => {
  const storage = memoryStorage();
  const store = new BlobStore(storage as unknown as Client, 'unit-test-bucket');
  const bytes = Buffer.from('逐字保留\n 示例内容  ', 'utf8');
  const first = await store.put(bytes);
  const second = await store.put(bytes);
  expect(first).toEqual({
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteSize: bytes.length,
  });
  expect(second).toEqual(first);
  expect(storage.putObject).toHaveBeenCalledTimes(1);
  expect(storage.setBucketPolicy).toHaveBeenCalledWith('unit-test-bucket', '');
  expect((await store.get(first.sha256)).equals(bytes)).toBe(true);
});

test('任意对象路径与过大内容在访问存储前被拒绝', async () => {
  const storage = memoryStorage();
  const store = new BlobStore(storage as unknown as Client, 'unit-test-bucket', 4);
  for (const key of ['../../secret', 'sha256/example', 'https://example.com', 'a'.repeat(63)]) {
    await expect(store.get(key)).rejects.toMatchObject({ code: 'BLOB_HASH_INVALID' });
  }
  await expect(store.put(Buffer.alloc(5))).rejects.toMatchObject({ code: 'BLOB_TOO_LARGE' });
  expect(storage.bucketExists).not.toHaveBeenCalled();
});

test('读取时验证完整性与大小，损坏对象不能成为可引用内容', async () => {
  const storage = memoryStorage();
  const store = new BlobStore(storage as unknown as Client, 'unit-test-bucket', 8);
  const first = await store.put(Buffer.from('original'));
  storage.objects.set(`sha256/${first.sha256}`, Buffer.from('tampered'));
  await expect(store.put(Buffer.from('original'))).rejects.toMatchObject({
    code: 'BLOB_INTEGRITY_FAILED',
  });
  await expect(store.get(first.sha256)).rejects.toMatchObject({ code: 'BLOB_INTEGRITY_FAILED' });
  storage.objects.set(`sha256/${first.sha256}`, Buffer.alloc(9));
  await expect(store.get(first.sha256)).rejects.toMatchObject({ code: 'BLOB_TOO_LARGE' });
});
