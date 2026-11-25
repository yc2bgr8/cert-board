import { createHash } from 'node:crypto';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { validateBackupManifest, verifyArchive } from './backup.mjs';

const image = `sha256:${'a'.repeat(64)}`;
const sha256 = 'f'.repeat(64);
const manifest = {
  version: 1,
  project: 'cert-board-isolated',
  archives: {
    postgres: { file: 'postgres.tar', image, sha256, bytes: 512 },
    minio: { file: 'minio.tar', image, sha256, bytes: 512 },
  },
};

test('备份清单仅接受指定项目、两卷的固定档名和镜像编号', () => {
  expect(validateBackupManifest(manifest)).toEqual(manifest.archives);
  for (const modified of [
    { ...manifest, project: 'cert-board' },
    { ...manifest, archives: { ...manifest.archives, other: {} } },
    { ...manifest, archives: { postgres: manifest.archives.postgres } },
    { ...manifest, archives: {
      ...manifest.archives, minio: { ...manifest.archives.minio, file: 'other.tar' },
    } },
    { ...manifest, archives: {
      ...manifest.archives, minio: { ...manifest.archives.minio, image: 'pgsty/minio' },
    } },
  ]) expect(() => validateBackupManifest(modified)).toThrow('备份清单');
});

test('同样大小的档案内容改变时校验失败', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'cert-board-archive-test-'));
  const file = path.join(folder, 'first.tar');
  const source = Buffer.from('original');
  const info = { bytes: source.length, sha256: createHash('sha256').update(source).digest('hex') };
  try {
    await writeFile(file, source, { flag: 'wx' });
    await expect(verifyArchive(file, info)).resolves.toBeUndefined();
    await writeFile(file, Buffer.from('modified'));
    await expect(verifyArchive(file, info)).rejects.toThrow('完整性校验失败');
  } finally {
    await unlink(file);
    await rmdir(folder);
  }
});
