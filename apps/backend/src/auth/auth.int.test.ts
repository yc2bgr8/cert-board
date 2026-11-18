import * as argon2 from 'argon2';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { authResponseSchema, parseBackendConfig, type BackendConfig } from '@cert-board/shared';
import { createApp } from '../app.js';
import { migrateDatabase } from '../db/migrate.js';
import { seedDevelopmentAccounts } from '../db/seed.js';
import { createTestDatabase } from '../db/test-database.js';
import { requireBrowserIdentity, sessionCookieName } from './session.js';

const passwordFor = (role: string) => ['integration', 'auth', role, 'example'].join('-');
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let config: BackendConfig;
let app: ReturnType<typeof createApp>;

function makeApp(settings = config) {
  return createApp(settings, {
    database: database.pool,
    checkDatabase: async () => undefined,
    checkStorage: async () => undefined,
    close: async () => undefined,
  });
}
const browserHeaders = () => ({ origin: config.WEB_ORIGIN, 'sec-fetch-site': 'same-origin' });
async function login(
  username = 'zhangsan',
  password = passwordFor(username),
  target = app,
  origin = config.WEB_ORIGIN,
) {
  return target.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin, 'sec-fetch-site': 'same-origin' },
    payload: { username, password },
  });
}
async function loggedIn(username = 'zhangsan') {
  const response = await login(username);
  expect(response.statusCode).toBe(200);
  const header = response.headers['set-cookie'];
  if (typeof header !== 'string') throw new Error('登录响应没有会话Cookie');
  const cookie = header.split(';')[0] ?? '';
  const body = response.json();
  return {
    cookie,
    csrf: body.csrfToken as string,
    userId: body.user.id as string,
    header,
    response,
  };
}

beforeAll(async () => {
  database = await createTestDatabase();
  await migrateDatabase(database.pool);
  await seedDevelopmentAccounts(database.pool, {
    NODE_ENV: 'test',
    DEV_ZHANGSAN_PASSWORD: passwordFor('zhangsan'),
    DEV_WANGMIN_PASSWORD: passwordFor('wangmin'),
    DEV_ADMIN_PASSWORD: passwordFor('admin'),
  });
  const normalHash = await argon2.hash(passwordFor('normal'), { type: argon2.argon2id });
  await database.pool.query(
    "INSERT INTO app_user (username, password_hash, display_name) VALUES ('normal', $1, '正式账号测试占位')",
    [normalHash],
  );
  config = parseBackendConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' });
});
beforeEach(() => {
  app = makeApp();
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  if (database) await database.dispose();
});

test.each(['zhangsan', 'wangmin', 'admin'])('成员%s能够登录并读取自己的身份', async (username) => {
  const session = await loggedIn(username);
  expect(authResponseSchema.safeParse(session.response.json()).success).toBe(true);
  expect(session.response.json().user.username).toBe(username);
  expect(session.response.json().user.isManagement).toBe(username === 'admin');
  expect(session.response.json().user.roles).toBeUndefined();
  const response = await app.inject({
    url: '/api/auth/me',
    headers: { cookie: session.cookie, 'sec-fetch-site': 'same-origin' },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().user.id).toBe(session.userId);
  expect(response.json().csrfToken === session.csrf).toBe(true);
  expect(response.headers['cache-control']).toBe('no-store');
});

test('会话Cookie具有保护属性，数据库只存令牌摘要，注销写审计并使会话失效', async () => {
  const session = await loggedIn();
  for (const attribute of ['HttpOnly', 'SameSite=Strict', 'Path=/api'])
    expect(session.header.includes(attribute)).toBe(true);
  expect(session.header.includes('Secure')).toBe(false);
  const rawToken = session.cookie.slice(sessionCookieName.length + 1);
  const stored = await database.pool.query(
    'SELECT token_hash, csrf_token_hash FROM web_session WHERE user_id = $1',
    [session.userId],
  );
  expect(
    stored.rows.every((row) => row.token_hash !== rawToken && row.csrf_token_hash !== session.csrf),
  ).toBe(true);
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: {
      ...browserHeaders(),
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
    },
  });
  expect(response.statusCode).toBe(204);
  const cleared = response.headers['set-cookie'];
  expect(typeof cleared === 'string' && cleared.includes(`${sessionCookieName}=;`)).toBe(true);
  const expired = await app.inject({
    url: '/api/auth/me',
    headers: { cookie: session.cookie, 'sec-fetch-site': 'same-origin' },
  });
  expect(expired.statusCode).toBe(401);
  const audits = await database.pool.query(
    'SELECT action, before_hash, after_hash FROM audit_log WHERE actor_user_id = $1',
    [session.userId],
  );
  expect(audits.rows.some((row) => row.action === 'auth.login')).toBe(true);
  expect(audits.rows.some((row) => row.action === 'auth.logout')).toBe(true);
  expect(JSON.stringify(audits.rows).includes(rawToken)).toBe(false);
  expect(JSON.stringify(audits.rows).includes(session.csrf)).toBe(false);
});

test('缺少、错误或另一会话的CSRF令牌不能注销', async () => {
  const first = await loggedIn();
  const second = await loggedIn('wangmin');
  for (const csrf of [undefined, 'invalid', second.csrf]) {
    const headers: Record<string, string> = { ...browserHeaders(), cookie: first.cookie };
    if (csrf !== undefined) headers['x-csrf-token'] = csrf;
    const response = await app.inject({ method: 'POST', url: '/api/auth/logout', headers });
    expect(response.statusCode).toBe(403);
  }
  const stillActive = await app.inject({
    url: '/api/auth/me',
    headers: { cookie: first.cookie, 'sec-fetch-site': 'same-origin' },
  });
  expect(stillActive.statusCode).toBe(200);
});

test('登录拒绝缺失Origin、跨Origin、跨站来源及非JSON请求', async () => {
  for (const headers of [
    { 'sec-fetch-site': 'same-origin' },
    { origin: 'https://untrusted.example', 'sec-fetch-site': 'same-origin' },
    { origin: config.WEB_ORIGIN, 'sec-fetch-site': 'cross-site' },
    { origin: config.WEB_ORIGIN },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers,
      payload: { username: 'zhangsan', password: passwordFor('zhangsan') },
    });
    expect(response.statusCode).toBe(403);
  }
  const text = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: {
      ...browserHeaders(),
      'content-type': 'text/plain',
    },
    payload: 'not-json',
  });
  expect(text.statusCode).toBe(415);
});

test('只有Cookie或CSRF、伪造后台调用和跨站写入均被拒绝', async () => {
  const session = await loggedIn();
  const attempts = [
    { cookie: session.cookie, 'x-csrf-token': session.csrf },
    { ...browserHeaders(), 'x-csrf-token': session.csrf },
    {
      ...browserHeaders(),
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
      origin: 'https://untrusted.example',
    },
    {
      ...browserHeaders(),
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
      'sec-fetch-site': 'cross-site',
    },
  ];
  for (const headers of attempts) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/logout', headers });
    expect([401, 403].includes(response.statusCode)).toBe(true);
  }
});

test('未知用户名和错误密码返回相同消息，不泄露密码或哈希', async () => {
  const wrongPassword = passwordFor('wrong');
  const first = await login('zhangsan', wrongPassword);
  const second = await login('unknown', wrongPassword);
  expect(first.statusCode).toBe(401);
  expect(second.statusCode).toBe(401);
  expect(first.json().error.code).toBe(second.json().error.code);
  expect(first.json().error.message).toBe(second.json().error.message);
  expect(first.body.includes(wrongPassword) || first.body.includes('$argon2')).toBe(false);
});

test('并发失败尝试最多接受五次验证，后续正确密码也受限速约束', async () => {
  const failures = await Promise.all(
    Array.from({ length: 8 }, () => login('zhangsan', passwordFor('wrong'))),
  );
  expect(failures.filter((response) => response.statusCode === 401)).toHaveLength(5);
  expect(failures.filter((response) => response.statusCode === 429)).toHaveLength(3);
  expect((await login()).statusCode).toBe(429);
});

test('一次成功登录不会清除该IP已经消耗的尝试次数', async () => {
  const first = await Promise.all(
    Array.from({ length: 15 }, (_value, index) =>
      login(`unknown-first-${index}`, passwordFor('wrong')),
    ),
  );
  expect(first.every((response) => response.statusCode === 401)).toBe(true);
  expect((await login()).statusCode).toBe(200);
  const next = await Promise.all(
    Array.from({ length: 15 }, (_value, index) =>
      login(`unknown-next-${index}`, passwordFor('wrong')),
    ),
  );
  expect(next.filter((response) => response.statusCode === 401)).toHaveLength(14);
  expect(next.filter((response) => response.statusCode === 429)).toHaveLength(1);
});

test('过期与人工禁用账号的现有会话都失效', async () => {
  const session = await loggedIn();
  await database.pool.query(
    "UPDATE web_session SET created_at = CURRENT_TIMESTAMP - INTERVAL '2 hours', expires_at = CURRENT_TIMESTAMP - INTERVAL '1 hour' WHERE user_id = $1",
    [session.userId],
  );
  expect(
    (
      await app.inject({
        url: '/api/auth/me',
        headers: { cookie: session.cookie, 'sec-fetch-site': 'same-origin' },
      })
    ).statusCode,
  ).toBe(401);
  const active = await loggedIn();
  try {
    await database.pool.query("UPDATE app_user SET status = 'disabled' WHERE id = $1", [
      active.userId,
    ]);
    expect(
      (
        await app.inject({
          url: '/api/auth/me',
          headers: { cookie: active.cookie, 'sec-fetch-site': 'same-origin' },
        })
      ).statusCode,
    ).toBe(401);
    expect((await login()).statusCode).toBe(401);
  } finally {
    await database.pool.query("UPDATE app_user SET status = 'active' WHERE id = $1", [
      active.userId,
    ]);
  }
});

test('requireBrowserIdentity读取当前管理权限，撤销立即反映到后续请求', async () => {
  app.post('/api/test/identity', async (request) =>
    requireBrowserIdentity(request, database.pool, config, { write: true }),
  );
  const session = await loggedIn('admin');
  const headers = { ...browserHeaders(), cookie: session.cookie, 'x-csrf-token': session.csrf };
  const initial = await app.inject({ method: 'POST', url: '/api/test/identity', headers });
  expect(initial.json().kind).toBe('browser');
  expect(initial.json().isManagement).toBe(true);
  try {
    await database.pool.query('UPDATE app_user SET is_management=false WHERE id=$1', [
      session.userId,
    ]);
    const updated = await app.inject({ method: 'POST', url: '/api/test/identity', headers });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().isManagement).toBe(false);
  } finally {
    await database.pool.query('UPDATE app_user SET is_management=true WHERE id=$1', [
      session.userId,
    ]);
  }
});

test('生产环境拒绝开发账号与其会话，正常账号Cookie要求Secure', async () => {
  const session = await loggedIn();
  const productionConfig = parseBackendConfig({
    ...config,
    NODE_ENV: 'production',
    WEB_ORIGIN: 'https://127.0.0.1:28080',
  });
  const production = makeApp(productionConfig);
  try {
    expect(
      (await login('zhangsan', passwordFor('zhangsan'), production, productionConfig.WEB_ORIGIN))
        .statusCode,
    ).toBe(401);
    const existing = await production.inject({
      url: '/api/auth/me',
      headers: { cookie: session.cookie, 'sec-fetch-site': 'same-origin' },
    });
    expect(existing.statusCode).toBe(401);
    const normal = await login(
      'normal',
      passwordFor('normal'),
      production,
      productionConfig.WEB_ORIGIN,
    );
    expect(normal.statusCode).toBe(200);
    const cookie = normal.headers['set-cookie'];
    expect(typeof cookie === 'string' && cookie.includes('Secure')).toBe(true);
  } finally {
    await production.close();
  }
});

test('同一浏览器重新登录会轮换会话，旧Cookie不再有效', async () => {
  const first = await loggedIn();
  const next = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: {
      ...browserHeaders(),
      cookie: first.cookie,
    },
    payload: { username: 'zhangsan', password: passwordFor('zhangsan') },
  });
  expect(next.statusCode).toBe(200);
  const old = await app.inject({
    url: '/api/auth/me',
    headers: { cookie: first.cookie, 'sec-fetch-site': 'same-origin' },
  });
  expect(old.statusCode).toBe(401);
});
