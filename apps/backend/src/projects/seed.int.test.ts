import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestDatabase } from '../db/test-database.js';
import { migrateDatabase } from '../db/migrate.js';
import { seedDevelopmentAccounts } from '../db/seed.js';
import { developmentProjectId, seedDevelopmentProject } from './seed.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
  await migrateDatabase(database.pool);
  await seedDevelopmentAccounts(database.pool, {
    NODE_ENV: 'test',
    ...Object.fromEntries(
      ['RA', 'RB', 'GM', 'SALES', 'TECH'].map((role) => [
        `DEV_${role}_PASSWORD`,
        ['seed', 'project', role, 'fixture'].join('-'),
      ]),
    ),
  });
});
afterAll(async () => {
  if (database) await database.dispose();
});

test('L08项目与目标种子幂等，未知期限和主体保持待确认', async () => {
  expect((await seedDevelopmentProject(database.pool, { NODE_ENV: 'test' })).created).toBe(true);
  await database.pool.query(
    'UPDATE cert_project SET next_action=$1,version=version+1 WHERE id=$2',
    ['人补充的方向', developmentProjectId],
  );
  expect((await seedDevelopmentProject(database.pool, { NODE_ENV: 'test' })).created).toBe(false);
  const project = await database.pool.query(
    'SELECT name,target_at,applicant_entity_id,holder_entity_id,model_id,next_action FROM cert_project',
  );
  expect(project.rows).toEqual([
    {
      name: 'L08 510(k)',
      target_at: null,
      applicant_entity_id: null,
      holder_entity_id: null,
      model_id: null,
      next_action: '人补充的方向',
    },
  ]);
  const goals = await database.pool.query('SELECT due_at,status,budget_usd FROM goal');
  expect(goals.rowCount).toBe(1);
  expect(goals.rows[0]).toMatchObject({ due_at: null, status: 'active' });
  expect(Number(goals.rows[0]?.budget_usd)).toBe(10);
});

test('生产环境绝不建立开发项目', async () => {
  await expect(seedDevelopmentProject(database.pool, { NODE_ENV: 'production' })).rejects.toThrow(
    '只允许',
  );
});
