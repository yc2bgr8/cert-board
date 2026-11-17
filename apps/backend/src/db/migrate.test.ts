import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { readMigrations } from './migrate.js';

test('迁移按编号读取，内容哈希用于检测已执行文件修改', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cert-migration-'));
  try {
    await writeFile(path.join(directory, '0001_first.sql'), 'SELECT 1;');
    const first = await readMigrations(directory);
    await writeFile(path.join(directory, '0001_first.sql'), 'SELECT 2;');
    const changed = await readMigrations(directory);
    expect(first[0]?.checksum).not.toBe(changed[0]?.checksum);
    await writeFile(path.join(directory, '0001_duplicate.sql'), 'SELECT 3;');
    await expect(readMigrations(directory)).rejects.toThrow('编号重复');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('拒绝空迁移和不规范编号', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cert-migration-'));
  try {
    await writeFile(path.join(directory, '0000_initial.sql'), '');
    await expect(readMigrations(directory)).rejects.toThrow('为空');
    await writeFile(path.join(directory, 'bad.sql'), 'SELECT 1;');
    await writeFile(path.join(directory, '0000_initial.sql'), 'SELECT 1;');
    await expect(readMigrations(directory)).rejects.toThrow('文件名无效');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
