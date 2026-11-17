import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { expect, test } from 'vitest';
import { initializeEnvironment } from './init-env.mjs';

test('首次生成隔离库与随机凭据，重复运行不改已有值', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cert-env-'));
  if (!directory.startsWith(path.join(tmpdir(), 'cert-env-'))) throw new Error('临时目录越界');
  try {
    const filename = path.join(directory, '.env.local');
    writeFileSync(filename, 'CUSTOM_VALUE=keep\n');
    initializeEnvironment(filename);
    const first = readFileSync(filename, 'utf8');
    const values = parseEnv(first);
    expect(values.POSTGRES_PASSWORD).toHaveLength(48);
    expect(values.MINIO_ROOT_PASSWORD).not.toEqual(values.POSTGRES_PASSWORD);
    expect(new URL(values.TEST_DATABASE_URL).pathname).toBe('/cert_board_test');
    expect(values.CUSTOM_VALUE).toBe('keep');
    expect(values.OPENROUTER_API_KEY).toBeUndefined();
    initializeEnvironment(filename);
    expect(readFileSync(filename, 'utf8')).toBe(first);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
