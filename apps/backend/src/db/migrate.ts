import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export async function readMigrations(directory: string) {
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  const seen = new Set<string>();
  const migrations = [];
  for (const filename of files) {
    const normalized = filename.normalize('NFC');
    const number = normalized.slice(0, 4);
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(normalized) || seen.has(number)) {
      throw new MigrationError('迁移文件名无效或编号重复，请检查四位编号与英文名称。');
    }
    seen.add(number);
    const sql = await readFile(path.join(directory, filename), 'utf8');
    if (!sql.trim()) throw new MigrationError(`迁移文件为空：${normalized}`);
    migrations.push({
      filename: normalized,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  return migrations;
}

export async function migrateDatabase(
  pool: pg.Pool,
  directory = fileURLToPath(new URL('./migrations', import.meta.url)),
): Promise<{ applied: string[] }> {
  const migrations = await readMigrations(directory);
  if (migrations.length === 0)
    throw new MigrationError('没有找到SQL迁移，请先生成并审阅迁移文件。');
  const client = await pool.connect();
  const applied: string[] = [];
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock(28081002)');
    locked = true;
    await client.query(`CREATE TABLE IF NOT EXISTS cert_schema_migration (
      filename text PRIMARY KEY,
      checksum text NOT NULL CHECK (length(checksum) = 64),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const history = await client.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM cert_schema_migration ORDER BY filename',
    );
    const existing = new Map(history.rows.map((row) => [row.filename, row.checksum]));
    for (const previous of history.rows) {
      const source = migrations.find((migration) => migration.filename === previous.filename);
      if (!source || source.checksum !== previous.checksum) {
        throw new MigrationError(
          `已执行的迁移被修改或缺失：${previous.filename}。请恢复原文件并另建迁移。`,
        );
      }
    }
    const last = history.rows.at(-1)?.filename ?? '';
    for (const migration of migrations) {
      if (existing.has(migration.filename)) continue;
      if (migration.filename < last)
        throw new MigrationError('不能插入早于已执行版本的迁移，请使用下一个编号。');
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO cert_schema_migration(filename, checksum) VALUES ($1, $2)',
          [migration.filename, migration.checksum],
        );
        await client.query('COMMIT');
        applied.push(migration.filename);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return { applied };
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock(28081002)');
    } finally {
      client.release();
    }
  }
}
