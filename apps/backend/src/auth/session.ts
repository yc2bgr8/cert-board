import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as argon2 from 'argon2';
import type { FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  authResponseSchema,
  browserIdentitySchema,
  type BackendConfig,
  type BrowserIdentity,
  type LoginInput,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';

export const sessionCookieName = 'cert_board_session';
const tokenPattern = /^[0-9a-f]{64}$/;
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const csrfForSession = (token: string) =>
  createHmac('sha256', token).update('cert-board-csrf-v1').digest('hex');
let dummyHash: Promise<string> | undefined;

function rejectedLogin() {
  return new AppError(401, 'LOGIN_FAILED', '用户名或密码不正确，请检查后重试。');
}

export function requireBrowserSource(
  request: FastifyRequest,
  config: BackendConfig,
  write: boolean,
) {
  const site = request.headers['sec-fetch-site'];
  if (site !== 'same-origin' && site !== 'same-site') {
    throw new AppError(403, 'BROWSER_REQUIRED', '请从本站浏览器界面操作，不接受跨站或后台请求。');
  }
  const origin = request.headers.origin;
  if ((write || origin !== undefined) && origin !== config.WEB_ORIGIN) {
    throw new AppError(403, 'ORIGIN_REJECTED', '请求来源不正确，请回到本站界面后重试。');
  }
}

type SessionRow = {
  session_id: string;
  user_id: string;
  username: string;
  display_name: string;
  is_development: boolean;
  csrf_token_hash: string;
  expires_at: Date;
  roles: unknown;
};

export async function readBrowserSession(
  request: FastifyRequest,
  pool: Pool,
  config: BackendConfig,
  options: { write?: boolean } = {},
) {
  requireBrowserSource(request, config, options.write === true);
  const token = request.cookies[sessionCookieName];
  if (typeof token !== 'string' || !tokenPattern.test(token)) {
    throw new AppError(401, 'LOGIN_REQUIRED', '请先登录，再继续操作。');
  }
  const result = await pool.query<SessionRow>(
    `SELECT s.id AS session_id, u.id AS user_id, u.username, u.display_name,
       u.is_development, s.csrf_token_hash, s.expires_at,
       COALESCE(jsonb_agg(jsonb_build_object('role', r.role, 'scopeType', r.scope_type,
         'scopeId', r.scope_id)) FILTER (WHERE r.id IS NOT NULL), '[]'::jsonb) AS roles
     FROM web_session s JOIN app_user u ON u.id = s.user_id
     LEFT JOIN role_binding r ON r.user_id = u.id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP
       AND u.status = 'active' AND ($2::boolean = false OR u.is_development = false)
     GROUP BY s.id, u.id`,
    [tokenHash(token), config.NODE_ENV === 'production'],
  );
  const session = result.rows[0];
  if (!session) throw new AppError(401, 'LOGIN_REQUIRED', '登录已失效，请重新登录。');
  const identity = browserIdentitySchema.parse({
    kind: 'browser',
    userId: session.user_id,
    sessionId: session.session_id,
    username: session.username,
    displayName: session.display_name,
    isDevelopment: session.is_development,
    roles: session.roles,
  });
  const csrfToken = csrfForSession(token);
  if (options.write) {
    const provided = request.headers['x-csrf-token'];
    if (
      typeof provided !== 'string' ||
      !tokenPattern.test(provided) ||
      !timingSafeEqual(
        Buffer.from(tokenHash(provided), 'hex'),
        Buffer.from(session.csrf_token_hash, 'hex'),
      )
    ) {
      throw new AppError(403, 'CSRF_REJECTED', '安全令牌缺失或已失效，请刷新页面后重试。');
    }
  }
  return { identity, csrfToken, expiresAt: session.expires_at.toISOString() };
}

export async function requireBrowserIdentity(
  request: FastifyRequest,
  pool: Pool,
  config: BackendConfig,
  options: { write?: boolean } = {},
): Promise<BrowserIdentity> {
  return (await readBrowserSession(request, pool, config, options)).identity;
}

type LoginUser = {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  status: string;
  is_development: boolean;
};

export async function loginSession(
  pool: Pool,
  config: BackendConfig,
  input: LoginInput,
  previousToken?: string,
) {
  const found = await pool.query<LoginUser>(
    'SELECT id, username, display_name, password_hash, status, is_development FROM app_user WHERE username = $1',
    [input.username],
  );
  const user = found.rows[0];
  const hash =
    user?.password_hash ??
    (await (dummyHash ??= argon2.hash(randomBytes(32).toString('hex'), {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    })));
  const verified = await argon2.verify(hash, input.password).catch(() => false);
  if (
    !user ||
    !verified ||
    user.status !== 'active' ||
    (config.NODE_ENV === 'production' && user.is_development)
  ) {
    await pool.query(
      `INSERT INTO audit_log (actor_kind, action, target_type, target_id)
       VALUES ('system', 'auth.login_failed', 'username', $1)`,
      [input.username],
    );
    throw rejectedLogin();
  }

  const token = randomBytes(32).toString('hex');
  const csrfToken = csrfForSession(token);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<LoginUser>(
      'SELECT id, username, display_name, password_hash, status, is_development FROM app_user WHERE id = $1 FOR SHARE',
      [user.id],
    );
    const lockedUser = current.rows[0];
    if (
      !lockedUser ||
      lockedUser.status !== 'active' ||
      lockedUser.password_hash !== user.password_hash ||
      (config.NODE_ENV === 'production' && lockedUser.is_development)
    )
      throw rejectedLogin();
    if (previousToken && tokenPattern.test(previousToken)) {
      await client.query(
        'UPDATE web_session SET revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE token_hash = $1 AND user_id = $2 AND revoked_at IS NULL',
        [tokenHash(previousToken), user.id],
      );
    }
    const inserted = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO web_session (user_id, token_hash, csrf_token_hash, expires_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP + $4 * INTERVAL '1 hour') RETURNING id, expires_at`,
      [user.id, tokenHash(token), tokenHash(csrfToken), config.SESSION_TTL_HOURS],
    );
    const session = inserted.rows[0];
    if (!session) throw new Error('会话建立失败');
    const roles = await client.query(
      'SELECT role, scope_type AS "scopeType", scope_id AS "scopeId" FROM role_binding WHERE user_id = $1 ORDER BY role, scope_type',
      [user.id],
    );
    const response = authResponseSchema.parse({
      user: {
        id: user.id,
        username: lockedUser.username,
        displayName: lockedUser.display_name,
        roles: roles.rows,
      },
      csrfToken,
      expiresAt: session.expires_at.toISOString(),
    });
    await client.query(
      `INSERT INTO audit_log (actor_user_id, actor_kind, action, target_type, target_id)
       VALUES ($1, 'browser', 'auth.login', 'web_session', $2)`,
      [user.id, session.id],
    );
    await client.query('COMMIT');
    return { token, response };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function logoutSession(pool: Pool, identity: BrowserIdentity) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE web_session SET revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
      [identity.sessionId, identity.userId],
    );
    if (!result.rowCount) throw new AppError(401, 'LOGIN_REQUIRED', '登录已失效，请重新登录。');
    await client.query(
      `INSERT INTO audit_log (actor_user_id, actor_kind, action, target_type, target_id)
       VALUES ($1, 'browser', 'auth.logout', 'web_session', $2)`,
      [identity.userId, identity.sessionId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

async function rollback(client: PoolClient) {
  await client.query('ROLLBACK').catch(() => undefined);
}
