import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { createTestDatabase } from '../db/test-database.js';
import { migrateDatabase } from '../db/migrate.js';
import { seedDevelopmentAccounts } from '../db/seed.js';
import { seedDevelopmentProject } from '../projects/seed.js';
import { developmentWorkspaceId, seedDevelopmentWorkspace } from './seed.js';
import type { DocumentBlobStore } from '../documents/blob-store.js';

test('固定开发workspace编号被其他项目占用时拒绝，不误认或覆盖', async () => {
  const database = await createTestDatabase();
  const store: DocumentBlobStore = {
    put: async () => {
      throw new Error('不应访问存储');
    },
    get: async () => {
      throw new Error('不应访问存储');
    },
  };
  try {
    await migrateDatabase(database.pool);
    await seedDevelopmentAccounts(database.pool, {
      NODE_ENV: 'test',
      ...Object.fromEntries(
        ['RA', 'RB', 'GM', 'SALES', 'TECH'].map((role) => [
          `DEV_${role}_PASSWORD`,
          ['seed', 'owner', role, 'fixture'].join('-'),
        ]),
      ),
    });
    await seedDevelopmentProject(database.pool, { NODE_ENV: 'test' });
    const users = await database.pool.query<{ id: string; username: string }>(
      "SELECT id,username FROM app_user WHERE username IN ('ra','rb')",
    );
    const owner = users.rows.find((row) => row.username === 'ra')!.id,
      reviewer = users.rows.find((row) => row.username === 'rb')!.id;
    const other = await database.pool.query<{ id: string }>(
      "INSERT INTO cert_project(name,market,pathway,owner_user_id,reviewer_user_id) VALUES ('另一个项目','US','测试路径',$1,$2) RETURNING id",
      [owner, reviewer],
    );
    const otherId = other.rows[0]!.id,
      versionId = randomUUID();
    await database.pool.query('INSERT INTO workspace(id,project_id) VALUES ($1,$2)', [
      developmentWorkspaceId,
      otherId,
    ]);
    await database.pool.query(
      "INSERT INTO workspace_version(id,workspace_id,project_id,number,author_type,summary,data_level) VALUES ($1,$2,$3,1,'system','测试初版','internal')",
      [versionId, developmentWorkspaceId, otherId],
    );
    await database.pool.query('UPDATE workspace SET current_version_id=$1 WHERE id=$2', [
      versionId,
      developmentWorkspaceId,
    ]);
    await expect(
      seedDevelopmentWorkspace(database.pool, store, { NODE_ENV: 'test' }),
    ).rejects.toThrow('冲突');
    expect(
      (
        await database.pool.query('SELECT project_id FROM workspace WHERE id=$1', [
          developmentWorkspaceId,
        ])
      ).rows[0]?.project_id,
    ).toBe(otherId);
  } finally {
    await database.dispose();
  }
});
