import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { registrationProjectResultSchema } from '@cert-board/shared';
import { createApp } from '../app.js';
import { createIntegrationContext } from '../test-support/context.js';

let context: Awaited<ReturnType<typeof createIntegrationContext>>;
let app: ReturnType<typeof createApp>;
let browser: Awaited<ReturnType<typeof context.login>>;
const files = new Map<string, Buffer>();
let storageUnavailable = false;

beforeAll(async () => {
  context = await createIntegrationContext();
  app = createApp(context.config, {
    database: context.pool,
    blobStore: {
      async put(content) {
        if (storageUnavailable) throw new Error('合成存储故障');
        const sha256 = createHash('sha256').update(content).digest('hex');
        files.set(sha256, Buffer.from(content));
        return { sha256, byteSize: content.length };
      },
      async get(sha256) {
        const blob = files.get(sha256);
        if (!blob) throw new Error('合成文件缺失');
        return Buffer.from(blob);
      },
    },
    checkDatabase: async () => undefined,
    checkStorage: async () => undefined,
    close: async () => undefined,
  });
  browser = await context.login();
});

afterAll(async () => {
  await app?.close();
  await context?.close();
});

const create = (payload: Record<string, unknown>, headers = browser.headers) =>
  app.inject({ method: 'POST', url: '/api/projects', payload, headers });

it('仅在带有效浏览器会话和 CSRF 的请求中建立注册项目', async () => {
  const payload = { requestKey: randomUUID(), name: '合成权限测试', market: 'US' };
  expect((await create(payload, { ...browser.headers, cookie: '' })).statusCode).toBe(401);
  expect((await create(payload, { ...browser.headers, 'x-csrf-token': '' })).statusCode).toBe(403);
  expect((await create({ ...payload, ownerUserId: randomUUID() })).statusCode).toBe(400);
  expect((await create({ ...payload, market: '其他市场' })).statusCode).toBe(400);
});

it('同一个请求并发只建一个项目、立项目标和带 AGENTS.md 的初始工作区', async () => {
  const payload = { requestKey: randomUUID(), name: '合成立项项目', market: 'CA' };
  const replies = await Promise.all([create(payload), create(payload)]);
  expect(replies.map(({ statusCode }) => statusCode)).toEqual([200, 200]);
  const [first, second] = replies.map((reply) =>
    registrationProjectResultSchema.parse(reply.json()),
  );
  expect(first!.project).toEqual(second!.project);
  expect(first!.goalId).toBe(second!.goalId);
  expect([first!.replayed, second!.replayed].sort()).toEqual([false, true]);
  expect(first!.project).toMatchObject({
    ownerUserId: context.userId('MEMBER_A'),
    market: 'CA',
    jurisdictionTz: 'America/Toronto',
    pathway: '待研判',
    projectType: 'registration',
    status: 'preparing',
  });
  const work = await context.pool.query<{ sha256: string }>(
    `SELECT f.sha256 FROM workspace w JOIN workspace_version v ON v.id=w.current_version_id
     JOIN workspace_file f ON f.version_id=v.id
     WHERE w.project_id=$1 AND v.number=1 AND f.path='AGENTS.md'`,
    [first!.project.id],
  );
  expect(work.rows).toHaveLength(1);
  expect(files.get(work.rows[0]!.sha256)?.toString('utf8')).toContain('这是新建立的注册项目');
  const goal = await context.pool.query('SELECT id,status,title FROM goal WHERE project_id=$1', [
    first!.project.id,
  ]);
  expect(goal.rows).toEqual([{ id: first!.goalId, status: 'active', title: '注册立项' }]);
  expect((await create({ ...payload, name: '不同的合成项目' })).statusCode).toBe(409);
});

it('存储故障回滚业务数据，同一个请求可以恢复', async () => {
  const payload = {
    requestKey: randomUUID(),
    name: '合成回滚样例',
    market: 'US',
    pathway: '510(k)',
  };
  storageUnavailable = true;
  try {
    expect((await create(payload)).statusCode).toBe(500);
    const projects = await context.pool.query('SELECT id FROM cert_project WHERE name=$1', [
      payload.name,
    ]);
    expect(projects.rowCount).toBe(0);
    const receipts = await context.pool.query(
      'SELECT project_id FROM browser_project_creation WHERE request_key=$1',
      [payload.requestKey],
    );
    expect(receipts.rowCount).toBe(0);
  } finally {
    storageUnavailable = false;
  }
  const recovered = await create(payload);
  expect(recovered.statusCode).toBe(200);
  expect(recovered.json()).toMatchObject({ replayed: false, project: { pathway: '510(k)' } });
});
