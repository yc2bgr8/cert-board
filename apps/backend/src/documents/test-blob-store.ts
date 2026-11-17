import { randomBytes } from 'node:crypto';
import { parseBackendConfig } from '@cert-board/shared';
import { createDependencies } from '../dependencies.js';
import { BlobStore } from './blob-store.js';

export async function createTestBlobStore() {
  if (process.env.NODE_ENV !== 'test') throw new Error('临时文件桶只允许在测试环境建立。');
  const config = parseBackendConfig(process.env);
  const dependencies = createDependencies(config);
  const bucket = `cert-test-${randomBytes(12).toString('hex')}`;
  if (!/^cert-test-[a-f0-9]{24}$/.test(bucket) || bucket === config.MINIO_BUCKET) {
    await dependencies.close();
    throw new Error('临时文件桶名称校验失败。');
  }
  let created = false;
  let disposing: Promise<void> | undefined;
  const dispose = () =>
    (disposing ??= (async () => {
      try {
        if (created) {
          // 桶名在本函数内随机生成，且只有本次makeBucket成功后才允许清理。
          const names: string[] = [];
          for await (const item of dependencies.storage.listObjectsV2(bucket, '', true)) {
            if (item.name) names.push(item.name);
            if (names.length === 1000)
              await dependencies.storage.removeObjects(bucket, names.splice(0));
          }
          if (names.length) await dependencies.storage.removeObjects(bucket, names);
          await dependencies.storage.removeBucket(bucket);
          created = false;
        }
      } finally {
        await dependencies.close();
      }
    })());
  try {
    if (await dependencies.storage.bucketExists(bucket))
      throw new Error('临时文件桶意外存在，已拒绝复用。');
    await dependencies.storage.makeBucket(bucket);
    created = true;
    const store = new BlobStore(dependencies.storage, bucket);
    await store.ensureBucket();
    return { store, client: dependencies.storage, bucket, dispose };
  } catch {
    await dispose();
    throw new Error('临时文件桶初始化失败，请检查测试存储环境。');
  }
}
