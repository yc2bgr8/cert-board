import { createHash } from 'node:crypto';
import type { Client } from 'minio';
import { AppError } from '../api/errors.js';

export type StoredBlob = { sha256: string; byteSize: number };
export interface DocumentBlobStore {
  put(content: Buffer): Promise<StoredBlob>;
  get(sha256: string): Promise<Buffer>;
}

function errorCode(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
}

export class BlobStore implements DocumentBlobStore {
  private ready: Promise<void> | undefined;
  constructor(
    private readonly client: Client,
    private readonly bucket: string,
    private readonly maxBytes = 25 * 1024 * 1024,
  ) {
    if (
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1
    ) {
      throw new AppError(500, 'BLOB_CONFIG_INVALID', '文件存储配置无效，请联系维护人员。');
    }
  }

  async ensureBucket() {
    this.ready ??= (async () => {
      if (!(await this.client.bucketExists(this.bucket))) {
        try {
          await this.client.makeBucket(this.bucket);
        } catch (error) {
          if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(errorCode(error)))
            throw error;
        }
      }
      // 只操作此项目配置的桶，移除匿名访问策略，保持资料私有。
      await this.client.setBucketPolicy(this.bucket, '');
    })().catch(() => {
      this.ready = undefined;
      throw new AppError(
        503,
        'BLOB_STORAGE_UNAVAILABLE',
        '文件存储不可用，请检查本地依赖服务后重试。',
      );
    });
    await this.ready;
  }

  async put(content: Buffer): Promise<StoredBlob> {
    if (!Buffer.isBuffer(content) || content.byteLength > this.maxBytes) {
      throw new AppError(413, 'BLOB_TOO_LARGE', '内容超过文件存储大小上限，请拆分资料后重试。');
    }
    const sha256 = createHash('sha256').update(content).digest('hex');
    await this.ensureBucket();
    const key = `sha256/${sha256}`;
    try {
      try {
        const existing = await this.client.statObject(this.bucket, key);
        if (existing.size !== content.byteLength)
          throw new AppError(
            500,
            'BLOB_INTEGRITY_FAILED',
            '存储内容校验失败，请联系维护人员核对资料。',
          );
        await this.get(sha256);
        return { sha256, byteSize: content.byteLength };
      } catch (error) {
        if (!['NoSuchKey', 'NotFound', 'NoSuchObject'].includes(errorCode(error))) throw error;
      }
      await this.client.putObject(this.bucket, key, content, content.byteLength, {
        'Content-Type': 'application/octet-stream',
      });
      return { sha256, byteSize: content.byteLength };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, 'BLOB_WRITE_FAILED', '文件内容保存失败，请检查存储连接后重试。');
    }
  }

  async get(sha256: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(sha256))
      throw new AppError(
        400,
        'BLOB_HASH_INVALID',
        '文件内容编号无效，请使用资料版本返回的SHA256编号。',
      );
    await this.ensureBucket();
    try {
      const stream = await this.client.getObject(this.bucket, `sha256/${sha256}`);
      const chunks: Buffer[] = [];
      let total = 0;
      const digest = createHash('sha256');
      try {
        for await (const part of stream) {
          const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
          total += chunk.byteLength;
          if (total > this.maxBytes)
            throw new AppError(
              413,
              'BLOB_TOO_LARGE',
              '存储内容超过读取上限，请联系维护人员核对资料。',
            );
          chunks.push(chunk);
          digest.update(chunk);
        }
      } finally {
        stream.destroy();
      }
      if (digest.digest('hex') !== sha256)
        throw new AppError(
          500,
          'BLOB_INTEGRITY_FAILED',
          '存储内容校验失败，不能作为资料使用，请联系维护人员。',
        );
      return Buffer.concat(chunks, total);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (['NoSuchKey', 'NotFound', 'NoSuchObject'].includes(errorCode(error))) {
        throw new AppError(
          404,
          'BLOB_NOT_FOUND',
          '未找到该版本的文件内容，请联系维护人员核对导入记录。',
        );
      }
      throw new AppError(503, 'BLOB_READ_FAILED', '文件内容读取失败，请检查存储连接后重试。');
    }
  }
}
