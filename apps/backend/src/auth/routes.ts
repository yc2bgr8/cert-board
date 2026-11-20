import type {
  FastifyInstance,
  FastifyBaseLogger,
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
} from 'fastify';
import type { Pool } from 'pg';
import { authResponseSchema, loginInputSchema, type BackendConfig } from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { LoginLimiter } from './login-limiter.js';
import {
  loginSession,
  logoutSession,
  readBrowserSession,
  requireBrowserIdentity,
  requireBrowserSource,
  browserSessionCookieName,
} from './session.js';

export function registerAuthRoutes<Logger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    Logger
  >,
  pool: Pool,
  config: BackendConfig,
) {
  const users = new LoginLimiter();
  const addresses = new LoginLimiter(undefined, 30);
  app.post('/api/auth/login', { bodyLimit: 4096 }, async (request, reply) => {
    requireBrowserSource(request, config, true);
    if (
      request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
    ) {
      throw new AppError(415, 'JSON_REQUIRED', '登录请求必须使用 JSON，请从本站登录页重试。');
    }
    const parsed = loginInputSchema.safeParse(request.body);
    if (!parsed.success)
      throw new AppError(400, 'INVALID_LOGIN_INPUT', '用户名或密码格式不正确，请检查后重试。');
    const userKey = parsed.data.username;
    const addressKey = request.ip;
    users.assertAllowed(userKey);
    addresses.assertAllowed(addressKey);
    // 在异步密码验证前预占次数，避免并发请求绕过上限。成功只清除该账号的失败次数。
    users.recordFailure(userKey);
    addresses.recordFailure(addressKey);
    const result = await loginSession(
      pool,
      config,
      parsed.data,
      request.cookies[browserSessionCookieName(config)],
    );
    users.reset(userKey);
    reply.header('cache-control', 'no-store');
    reply.setCookie(browserSessionCookieName(config), result.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.NODE_ENV === 'production',
      path: '/api',
      maxAge: config.SESSION_TTL_HOURS * 60 * 60,
    });
    return result.response;
  });

  app.get('/api/auth/me', async (request, reply) => {
    const session = await readBrowserSession(request, pool, config);
    reply.header('cache-control', 'no-store');
    return authResponseSchema.parse({
      user: {
        id: session.identity.userId,
        username: session.identity.username,
        displayName: session.identity.displayName,
        isManagement: session.identity.isManagement,
      },
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
    });
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const identity = await requireBrowserIdentity(request, pool, config, { write: true });
    await logoutSession(pool, identity);
    reply.header('cache-control', 'no-store');
    reply.clearCookie(browserSessionCookieName(config), {
      path: '/api',
      httpOnly: true,
      sameSite: 'strict',
      secure: config.NODE_ENV === 'production',
    });
    return reply.status(204).send();
  });
}
