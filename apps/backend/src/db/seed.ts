import * as argon2 from 'argon2';
import type { Pool, PoolClient } from 'pg';
import { parseSeedEnvironment } from '@cert-board/shared';

const accounts = [
  {
    username: 'ra',
    role: 'RA',
    displayName: '注册人员A（开发）',
    passwordField: 'DEV_RA_PASSWORD',
    scope: 'global',
  },
  {
    username: 'rb',
    role: 'RB',
    displayName: '注册人员B（开发）',
    passwordField: 'DEV_RB_PASSWORD',
    scope: 'global',
  },
  {
    username: 'gm',
    role: 'GM',
    displayName: '管理人员（开发）',
    passwordField: 'DEV_GM_PASSWORD',
    scope: 'global',
  },
  {
    username: 'sales',
    role: 'SALES',
    displayName: '销售人员（开发）',
    passwordField: 'DEV_SALES_PASSWORD',
    scope: 'own',
  },
  {
    username: 'tech',
    role: 'TECH',
    displayName: '技术维护（开发）',
    passwordField: 'DEV_TECH_PASSWORD',
    scope: 'global',
  },
] as const;

export class DevelopmentSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevelopmentSeedError';
  }
}

export async function seedDevelopmentAccounts(pool: Pool, environment: Record<string, unknown>) {
  const config = parseSeedEnvironment(environment);
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // 多个初始化进程共享事务锁；同名非开发账号绝不被种子接管。
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [20261117, 2]);
    const existing = await client.query<{ id: string; username: string; is_development: boolean }>(
      'SELECT id, username, is_development FROM app_user WHERE username = ANY($1::text[]) FOR UPDATE',
      [accounts.map((account) => account.username)],
    );
    const users = new Map(existing.rows.map((user) => [user.username, user]));
    for (const user of existing.rows) {
      if (!user.is_development)
        throw new DevelopmentSeedError(
          `账号 ${user.username} 已存在且不是开发账号；请人工处理命名冲突，种子不会修改其权限。`,
        );
    }

    const created: string[] = [];
    const unchanged: string[] = [];
    for (const account of accounts) {
      if (users.has(account.username)) {
        unchanged.push(account.username);
        continue;
      }
      const passwordHash = await argon2.hash(config[account.passwordField], {
        type: argon2.argon2id,
        memoryCost: 65_536,
        timeCost: 3,
        parallelism: 1,
      });
      const result = await client.query<{ id: string }>(
        `INSERT INTO app_user (username, password_hash, display_name, is_development)
         VALUES ($1, $2, $3, true) ON CONFLICT (username) DO NOTHING RETURNING id`,
        [account.username, passwordHash, account.displayName],
      );
      const id = result.rows[0]?.id;
      if (!id)
        throw new DevelopmentSeedError(
          `账号 ${account.username} 在初始化期间被创建；请核对账号归属后重试。`,
        );
      await client.query(
        'INSERT INTO role_binding (user_id, role, scope_type) VALUES ($1, $2, $3)',
        [id, account.role, account.scope],
      );
      await client.query(
        `INSERT INTO audit_log (actor_kind, action, target_type, target_id)
         VALUES ('system', 'user.seeded', 'app_user', $1)`,
        [id],
      );
      created.push(account.username);
    }
    await client.query('COMMIT');
    return { created, unchanged };
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof DevelopmentSeedError) throw error;
    throw new DevelopmentSeedError('开发账号初始化失败，请检查数据库迁移和连接后重试。');
  } finally {
    client?.release();
  }
}
