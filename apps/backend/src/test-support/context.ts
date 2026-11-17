import { randomUUID } from 'node:crypto';
import { parseBackendConfig, type Role } from '@cert-board/shared';
import { createTestDatabase } from '../db/test-database.js';
import { migrateDatabase } from '../db/migrate.js';
import { seedDevelopmentAccounts } from '../db/seed.js';
import {
  seedDevelopmentProject,
  developmentProjectId,
  developmentGoalId,
} from '../projects/seed.js';
import { createApp } from '../app.js';

export async function createIntegrationContext() {
  const database = await createTestDatabase();
  let app: ReturnType<typeof createApp> | undefined;
  try {
    await migrateDatabase(database.pool);
    const password = (role: string) => ['cert', 'integration', role, 'fixture'].join('-');
    await seedDevelopmentAccounts(database.pool, {
      NODE_ENV: 'test',
      ...Object.fromEntries(
        ['RA', 'RB', 'GM', 'SALES', 'TECH'].map((role) => [
          `DEV_${role}_PASSWORD`,
          password(role.toLowerCase()),
        ]),
      ),
    });
    await seedDevelopmentProject(database.pool, { NODE_ENV: 'test' });
    const users = await database.pool.query<{ id: string; username: string }>(
      'SELECT id,username FROM app_user',
    );
    const userId = (role: Role) => {
      const user = users.rows.find((user) => user.username === role.toLowerCase());
      if (!user) throw new Error('缺少测试角色');
      return user.id;
    };
    const config = parseBackendConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    app = createApp(config, {
      database: database.pool,
      checkDatabase: async () => undefined,
      checkStorage: async () => undefined,
      close: async () => undefined,
    });
    const application = app;
    return {
      pool: database.pool,
      app: application,
      config,
      projectId: developmentProjectId,
      goalId: developmentGoalId,
      userId,
      async login(role: Role = 'RA') {
        const response = await application.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { origin: config.WEB_ORIGIN, 'sec-fetch-site': 'same-origin' },
          payload: { username: role.toLowerCase(), password: password(role.toLowerCase()) },
        });
        if (response.statusCode !== 200) throw new Error('测试登录失败，请检查认证测试前置条件。');
        const cookie = String(response.headers['set-cookie']).split(';')[0] ?? '';
        return {
          cookie,
          csrfToken: response.json().csrfToken as string,
          headers: {
            cookie,
            origin: config.WEB_ORIGIN,
            'sec-fetch-site': 'same-origin',
            'x-csrf-token': response.json().csrfToken as string,
          },
        };
      },
      async run(role: Role = 'RA', mode: 'read_only' | 'execute' = 'execute') {
        const conversation = await database.pool.query<{ id: string }>(
          'INSERT INTO conversation(project_id,user_id,goal_id,title,mode) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [developmentProjectId, userId(role), developmentGoalId, '独立集成测试', mode],
        );
        const conversationId = conversation.rows[0]!.id;
        const run = await database.pool.query<{ id: string }>(
          "INSERT INTO run(conversation_id,user_id,project_id,goal_id,status) VALUES($1,$2,$3,$4,'running') RETURNING id",
          [conversationId, userId(role), developmentProjectId, developmentGoalId],
        );
        return {
          runId: run.rows[0]!.id,
          userId: userId(role),
          callId: randomUUID(),
          conversationId,
        };
      },
      async close() {
        await application.close();
        await database.dispose();
      },
    };
  } catch (error) {
    if (app) await app.close();
    await database.dispose();
    throw error;
  }
}
