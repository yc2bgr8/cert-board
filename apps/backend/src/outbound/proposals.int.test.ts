import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import {
  browserIdentitySchema,
  parseBackendConfig,
  proposalToolResultSchema,
  type BackendConfig,
  type BrowserIdentity,
} from '@cert-board/shared';
import { createApp } from '../app.js';
import { createTestDatabase } from '../db/test-database.js';
import { migrateDatabase } from '../db/migrate.js';
import { seedDevelopmentAccounts } from '../db/seed.js';
import { createProject } from '../projects/service.js';
import { ToolRegistry } from '../tools/registry.js';
import { proposeExternalTool } from '../tools/propose-external.js';
import { processTestOutbound } from './service.js';
import * as approvalModule from '../api/proposal-routes.js';
import { readMemberNotifications } from '../conversations/read.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let config: BackendConfig;
let app: ReturnType<typeof createApp>;
let memberA: BrowserIdentity;
let memberBId: string;
let projectId: string;
let goalId: string;
let contactId: string;
let conversationId: string;
let runId: string;
let registry: ToolRegistry;
let caseNumber = 0;
const password = (username: string) => ['proposal', 'integration', username, 'example'].join('-');
type Browser = { cookie: string; csrf: string };
async function login(username = 'wangmin'): Promise<Browser> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: config.WEB_ORIGIN, 'sec-fetch-site': 'same-origin' },
    payload: { username, password: password(username) },
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.headers['set-cookie'];
  if (typeof cookie !== 'string') throw new Error('测试登录没有Cookie');
  return { cookie: cookie.split(';')[0]!, csrf: response.json().csrfToken as string };
}
function headers(browser: Browser) {
  return {
    origin: config.WEB_ORIGIN,
    'sec-fetch-site': 'same-origin',
    cookie: browser.cookie,
    'x-csrf-token': browser.csrf,
  };
}
async function proposal(callId = 'proposal') {
  const result = await registry.execute(
    { runId, userId: memberA.userId, callId },
    'propose_external',
    {
      contactId,
      subject: '虚构测试提案',
      body: 'PRIVATE_LOCAL_PROPOSAL_BODY\n仅验证本地队列，不发送给任何外部对象。',
    },
  );
  return { ...proposalToolResultSchema.parse(result.data), invocationId: result.invocationId };
}
async function approve(id: string, browser: Browser, version = 1, requestKey = randomUUID()) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/proposals/${id}/decision`,
    headers: headers(browser),
    payload: { expectedVersion: version, action: 'approved', requestKey },
  });
  expect(response.statusCode).toBe(200);
  return {
    response,
    ...(response.json() as {
      proposalId: string;
      status: string;
      version: number;
      decisionId: string;
      queueId: string;
      replayed: boolean;
    }),
    requestKey,
  };
}
async function control(browser: Browser, paused: boolean, expectedVersion: number) {
  return app.inject({
    method: 'POST',
    url: `/api/goals/${goalId}/outbound-control`,
    headers: headers(browser),
    payload: { paused, expectedVersion },
  });
}

beforeAll(async () => {
  database = await createTestDatabase();
  await migrateDatabase(database.pool);
  await seedDevelopmentAccounts(database.pool, {
    NODE_ENV: 'test',
    DEV_ZHANGSAN_PASSWORD: password('zhangsan'),
    DEV_WANGMIN_PASSWORD: password('wangmin'),
    DEV_ADMIN_PASSWORD: password('admin'),
  });
  const users = await database.pool.query(
    "SELECT id,username,display_name,is_management FROM app_user WHERE username IN ('zhangsan','wangmin')",
  );
  const user = users.rows.find((row) => row.username === 'zhangsan');
  memberBId = users.rows.find((row) => row.username === 'wangmin').id;
  memberA = browserIdentitySchema.parse({
    kind: 'browser',
    userId: user.id,
    sessionId: randomUUID(),
    username: user.username,
    displayName: user.display_name,
    isDevelopment: true,
    isManagement: user.is_management,
  });
  config = parseBackendConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' });
});
beforeEach(async () => {
  projectId = (
    await createProject(database.pool, memberA, {
      name: `提案审批测试${++caseNumber}`,
      projectType: 'registration',
      market: 'US',
      pathway: '510(k)',
      reviewerUserId: memberBId,
    })
  ).id;
  goalId = (
    await database.pool.query<{ id: string }>(
      "INSERT INTO goal(project_id,owner_user_id,title,acceptance_criteria) VALUES($1,$2,'提案测试目标','验证审批与本地队列') RETURNING id",
      [projectId, memberA.userId],
    )
  ).rows[0]!.id;
  contactId = (
    await database.pool.query<{ id: string }>(
      "INSERT INTO contact(project_id,name,address,source) VALUES($1,'虚构测试收件人','local-test:recipient','合成测试联系人') RETURNING id",
      [projectId],
    )
  ).rows[0]!.id;
  conversationId = (
    await database.pool.query<{ id: string }>(
      "INSERT INTO conversation(project_id,user_id,goal_id,title) VALUES($1,$2,$3,'提案测试对话') RETURNING id",
      [projectId, memberA.userId, goalId],
    )
  ).rows[0]!.id;
  runId = (
    await database.pool.query<{ id: string }>(
      "INSERT INTO run(conversation_id,user_id,project_id,goal_id,direction_version,status) VALUES($1,$2,$3,$4,1,'running') RETURNING id",
      [conversationId, memberA.userId, projectId, goalId],
    )
  ).rows[0]!.id;
  registry = new ToolRegistry(database.pool, [proposeExternalTool()]);
  app = createApp(config, {
    database: database.pool,
    checkDatabase: async () => undefined,
    checkStorage: async () => undefined,
    close: async () => undefined,
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await app.close();
});
afterAll(async () => {
  if (database) await database.dispose();
});

test('登记工具只建立proposed提案，无审批和队列；正文只在业务提案中', async () => {
  const created = await proposal();
  expect(created.status).toBe('proposed');
  expect(created.sent).toBe(false);
  expect(
    (
      await database.pool.query('SELECT id FROM decision WHERE proposal_id=$1', [
        created.proposalId,
      ])
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await database.pool.query('SELECT id FROM outbound_message WHERE proposal_id=$1', [
        created.proposalId,
      ])
    ).rowCount,
  ).toBe(0);
  const metadata = await database.pool.query('SELECT * FROM tool_invocation WHERE id=$1', [
    created.invocationId,
  ]);
  expect(JSON.stringify(metadata.rows).includes('PRIVATE_LOCAL_PROPOSAL_BODY')).toBe(false);
  const browser = await login();
  const read = await app.inject({
    url: `/api/proposals/${created.proposalId}`,
    headers: headers(browser),
  });
  expect(read.statusCode).toBe(200);
  expect(read.json().body.includes('PRIVATE_LOCAL_PROPOSAL_BODY')).toBe(true);
  expect(read.json().channel).toBe('local_test');
  expect(Object.keys(approvalModule)).toEqual(['registerProposalRoutes']);
});

test('浏览器按对话分页读取提案状态，保留决定且不返回正文或联系人', async () => {
  const first = await proposal('history-first');
  const second = await proposal('history-second');
  const browser = await login();
  await approve(first.proposalId, browser);
  const path = `/api/conversations/${conversationId}/proposals`;
  expect((await app.inject({ url: path })).statusCode).toBe(403);
  expect(
    (
      await app.inject({
        url: path,
        headers: { origin: config.WEB_ORIGIN, 'sec-fetch-site': 'same-origin' },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (await app.inject({ url: `${path}?limit=51`, headers: headers(browser) })).statusCode,
  ).toBe(400);
  const listed = await app.inject({ url: `${path}?limit=1`, headers: headers(browser) });
  expect(listed.statusCode).toBe(200);
  expect(listed.headers['cache-control']).toBe('no-store');
  expect(listed.json().hasMore).toBe(true);
  const next = await app.inject({
    url: `${path}?limit=1&cursor=${listed.json().nextCursor}`,
    headers: headers(browser),
  });
  expect(next.statusCode).toBe(200);
  expect(next.json().hasMore).toBe(false);
  expect(next.json().nextCursor).toBeNull();
  expect([...listed.json().items, ...next.json().items]).toEqual(
    [
      { id: first.proposalId, status: 'approved' },
      { id: second.proposalId, status: 'proposed' },
    ].sort((left, right) => left.id.localeCompare(right.id)),
  );
});

test('没有浏览器会话、CSRF或正确来源时拒绝，Agent声明不构成审批', async () => {
  const created = await proposal();
  const body = { expectedVersion: 1, action: 'approved', requestKey: randomUUID() };
  const url = `/api/proposals/${created.proposalId}/decision`;
  const anonymous = await app.inject({
    method: 'POST',
    url,
    headers: { origin: config.WEB_ORIGIN, 'sec-fetch-site': 'same-origin' },
    payload: { ...body, actor: { kind: 'browser', userId: memberA.userId } },
  });
  expect(anonymous.statusCode).toBe(401);
  const fakeAgent = await app.inject({
    method: 'POST',
    url,
    headers: {
      origin: config.WEB_ORIGIN,
      'sec-fetch-site': 'same-origin',
      authorization: 'Bearer test-agent-declaration',
    },
    payload: body,
  });
  expect(fakeAgent.statusCode).toBe(401);
  const browser = await login();
  const noCsrf = await app.inject({
    method: 'POST',
    url,
    headers: { origin: config.WEB_ORIGIN, 'sec-fetch-site': 'same-origin', cookie: browser.cookie },
    payload: body,
  });
  expect(noCsrf.statusCode).toBe(403);
  const wrongOrigin = await app.inject({
    method: 'POST',
    url,
    headers: { ...headers(browser), origin: 'https://untrusted.example' },
    payload: body,
  });
  expect(wrongOrigin.statusCode).toBe(403);
  const extraIdentity = await app.inject({
    method: 'POST',
    url,
    headers: headers(browser),
    payload: { ...body, actor: { kind: 'agent' } },
  });
  expect(extraIdentity.statusCode).toBe(400);
  expect(
    (
      await database.pool.query('SELECT id FROM decision WHERE proposal_id=$1', [
        created.proposalId,
      ])
    ).rowCount,
  ).toBe(0);
});

test('批准先记录决定和待执行队列，重复请求仅重放，发送器只产生一次本地回执', async () => {
  const created = await proposal(),
    browser = await login();
  const first = await approve(created.proposalId, browser);
  expect(first.status).toBe('approved');
  expect(first.version).toBe(2);
  const queued = await database.pool.query(
    'SELECT status,attempts,approved_version FROM outbound_message WHERE id=$1',
    [first.queueId],
  );
  expect(queued.rows[0]).toEqual({ status: 'queued', attempts: 0, approved_version: 2 });
  const repeated = await approve(created.proposalId, browser, 1, first.requestKey);
  expect(repeated.replayed).toBe(true);
  expect(repeated.decisionId).toBe(first.decisionId);
  expect(repeated.queueId).toBe(first.queueId);
  const changed = await app.inject({
    method: 'POST',
    url: `/api/proposals/${created.proposalId}/decision`,
    headers: headers(browser),
    payload: { expectedVersion: 1, action: 'rejected', requestKey: first.requestKey },
  });
  expect(changed.statusCode).toBe(409);
  const results = await Promise.all([
    processTestOutbound(database.pool, first.queueId),
    processTestOutbound(database.pool, first.queueId),
  ]);
  expect(
    results.every(
      (result) =>
        result.status === 'done' &&
        result.attempts === 1 &&
        result.receipt?.channel === 'local_test',
    ),
  ).toBe(true);
  expect(results[0]!.receipt?.id).toBe(results[1]!.receipt?.id);
  expect(results[0]!.reason?.includes('未向任何外部对象发送')).toBe(true);
  expect(
    (
      await database.pool.query('SELECT id FROM outbound_message WHERE proposal_id=$1', [
        created.proposalId,
      ])
    ).rowCount,
  ).toBe(1);
  expect(
    (
      await database.pool.query(
        "SELECT actor_kind FROM audit_log WHERE action='proposal.approved' AND target_id=$1",
        [created.proposalId],
      )
    ).rows,
  ).toEqual([{ actor_kind: 'browser' }]);
});

test('同一版本的并发批准只接受一次，不重复生成队列', async () => {
  const created = await proposal(),
    browser = await login();
  const decisions = await Promise.all(
    [randomUUID(), randomUUID()].map((requestKey) =>
      app.inject({
        method: 'POST',
        url: `/api/proposals/${created.proposalId}/decision`,
        headers: headers(browser),
        payload: { expectedVersion: 1, action: 'approved', requestKey },
      }),
    ),
  );
  expect(decisions.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  expect(
    (
      await database.pool.query('SELECT id FROM decision WHERE proposal_id=$1', [
        created.proposalId,
      ])
    ).rowCount,
  ).toBe(1);
  expect(
    (
      await database.pool.query('SELECT id FROM outbound_message WHERE proposal_id=$1', [
        created.proposalId,
      ])
    ).rowCount,
  ).toBe(1);
});

test('非负责人部门成员可暂停且不发送，恢复取消旧队列并要求新的版本批准', async () => {
  const created = await proposal(),
    reviewer = await login();
  const first = await approve(created.proposalId, reviewer);
  const paused = await control(reviewer, true, 1);
  expect(paused.statusCode).toBe(200);
  expect((await processTestOutbound(database.pool, first.queueId)).status).toBe('queued');
  expect(
    (
      await database.pool.query('SELECT attempts FROM outbound_message WHERE id=$1', [
        first.queueId,
      ])
    ).rows[0].attempts,
  ).toBe(0);
  const resumed = await control(reviewer, false, paused.json().version);
  expect(resumed.statusCode).toBe(200);
  expect(resumed.json().resetProposalIds).toEqual([created.proposalId]);
  const state = await app.inject({
    url: `/api/proposals/${created.proposalId}`,
    headers: headers(reviewer),
  });
  expect(state.json().status).toBe('proposed');
  expect(state.json().version).toBe(3);
  expect((await processTestOutbound(database.pool, first.queueId)).status).toBe('cancelled');
  const old = await approve(created.proposalId, reviewer, 1, first.requestKey);
  expect(old.replayed).toBe(true);
  expect(old.status).toBe('proposed');
  const fresh = await approve(created.proposalId, reviewer, 3);
  expect(fresh.queueId === first.queueId).toBe(false);
  expect(fresh.version).toBe(4);
  const repeatedResume = await control(reviewer, false, paused.json().version);
  expect(repeatedResume.statusCode).toBe(200);
  expect(repeatedResume.json().resetProposalIds).toEqual([]);
  expect((await processTestOutbound(database.pool, fresh.queueId)).status).toBe('done');
});

test('部门成员同权处理外发，管理权限不构成额外业务角色', async () => {
  const created = await proposal(),
    reviewer = await login(),
    manager = await login('admin');
  const paused = await control(reviewer, true, 1);
  expect(paused.statusCode).toBe(200);
  expect((await control(manager, false, paused.json().version)).statusCode).toBe(200);
  expect(
    (await app.inject({ url: `/api/proposals/${created.proposalId}`, headers: headers(manager) }))
      .statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/proposals/${created.proposalId}/decision`,
        headers: headers(manager),
        payload: { expectedVersion: 1, action: 'approved', requestKey: randomUUID() },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await database.pool.query(
        'SELECT u.username FROM decision d JOIN app_user u ON u.id=d.actor_user_id WHERE d.proposal_id=$1',
        [created.proposalId],
      )
    ).rows[0].username,
  ).toBe('admin');
});

test.each(['inactive', 'address', 'name', 'version'])(
  '发送前联系人%s改变时失败且不发生发送尝试',
  async (change) => {
    const created = await proposal(),
      browser = await login();
    const approved = await approve(created.proposalId, browser);
    const statements = {
      inactive: 'UPDATE contact SET active=false,version=version+1 WHERE id=$1',
      address: "UPDATE contact SET address='local-test:changed' WHERE id=$1",
      name: "UPDATE contact SET name='另一测试名称' WHERE id=$1",
      version: 'UPDATE contact SET version=version+1 WHERE id=$1',
    };
    await database.pool.query(statements[change as keyof typeof statements], [contactId]);
    const outcome = await processTestOutbound(database.pool, approved.queueId);
    expect(outcome.status).toBe('failed');
    expect(outcome.attempts).toBe(0);
    expect(outcome.receipt).toBeNull();
    expect(outcome.reason?.includes('收件人')).toBe(true);
  },
);

test('审批时联系人改变就拒绝，不入队', async () => {
  const created = await proposal(),
    browser = await login();
  await database.pool.query('UPDATE contact SET active=false,version=version+1 WHERE id=$1', [
    contactId,
  ]);
  const result = await app.inject({
    method: 'POST',
    url: `/api/proposals/${created.proposalId}/decision`,
    headers: headers(browser),
    payload: { expectedVersion: 1, action: 'approved', requestKey: randomUUID() },
  });
  expect(result.statusCode).toBe(409);
  expect(result.json().error.code).toBe('PROPOSAL_RECIPIENT_CHANGED');
  expect(
    (
      await database.pool.query('SELECT id FROM outbound_message WHERE proposal_id=$1', [
        created.proposalId,
      ])
    ).rowCount,
  ).toBe(0);
});

test.each(['cancelled', 'paused', 'human_controlled', 'completed'])(
  '目标%s时后台不能继续执行已批准外发',
  async (status) => {
    const created = await proposal(),
      browser = await login();
    const approved = await approve(created.proposalId, browser);
    await database.pool.query('UPDATE goal SET status=$1,version=version+1 WHERE id=$2', [
      status,
      goalId,
    ]);
    const outcome = await processTestOutbound(database.pool, approved.queueId);
    expect(outcome.status).toBe('failed');
    expect(outcome.attempts).toBe(0);
    expect(outcome.receipt).toBeNull();
  },
);

test('不确定结果进入reconcile，之后不能通过重试变成成功或再次排队', async () => {
  const created = await proposal(),
    browser = await login();
  const approved = await approve(created.proposalId, browser);
  const unknown = await processTestOutbound(database.pool, approved.queueId, {
    simulate: 'uncertain',
  });
  expect(unknown.status).toBe('reconcile');
  expect(unknown.attempts).toBe(1);
  expect(unknown.receipt).toBeNull();
  const repeated = await processTestOutbound(database.pool, approved.queueId, {
    simulate: 'success',
  });
  expect(repeated).toEqual(unknown);
  await expect(
    database.pool.query("UPDATE outbound_message SET status='queued' WHERE id=$1", [
      approved.queueId,
    ]),
  ).rejects.toMatchObject({ code: '42501' });
  expect(
    (await database.pool.query('SELECT status FROM proposal WHERE id=$1', [created.proposalId]))
      .rows[0].status,
  ).toBe('reconcile');
});

test.each([
  { folder: 'auto_store', status: 'done', filed: true },
  { folder: 'no_store', status: 'reconcile', filed: false },
  { folder: 'unavailable', status: 'reconcile', filed: false },
] as const)('邮件超时按编号对账：$folder', async ({ folder, status, filed }) => {
  const created = await proposal();
  const approved = await approve(created.proposalId, await login());
  const preflight = (
    await database.pool.query<{ dispatch_id: string }>(
      'SELECT dispatch_id FROM outbound_message WHERE id=$1',
      [approved.queueId],
    )
  ).rows[0]!;
  expect(preflight.dispatch_id).toBe(`<${approved.queueId}@cert-board.local>`);
  const first = await processTestOutbound(database.pool, approved.queueId, {
    simulate: 'uncertain',
    sentFolder: folder,
  });
  expect(first).toMatchObject({ dispatchId: preflight.dispatch_id, status, attempts: 1 });
  expect(
    await processTestOutbound(database.pool, approved.queueId, { simulate: 'success' }),
  ).toEqual(first);
  const calls = (
    await database.pool.query(
      'SELECT reply,provider_filed FROM simulated_email_delivery WHERE queue_id=$1',
      [approved.queueId],
    )
  ).rows;
  expect(calls).toEqual([{ reply: 'uncertain', provider_filed: filed }]);
});

test.each(['confirm_sent', 'repropose'] as const)(
  '仅发起人能对账，原编号不会再次发送：%s',
  async (action) => {
    const created = await proposal();
    const approver = await login();
    const approved = await approve(created.proposalId, approver);
    await processTestOutbound(database.pool, approved.queueId, { simulate: 'uncertain' });
    const url = `/api/proposals/${created.proposalId}/reconciliation`;
    const requester = await login('zhangsan');
    const expected = (await app.inject({ url, headers: headers(requester) })).json() as {
      version: number;
      dispatchId: string;
    };
    expect(expected).toMatchObject({
      status: 'reconcile',
      dispatchId: `<${approved.queueId}@cert-board.local>`,
    });
    expect((await app.inject({ url, headers: headers(approver) })).json()).toBeNull();
    const notice = async () =>
      (await readMemberNotifications(database.pool, memberA)).items.find(
        ({ kind, id }) => kind === 'outbound' && id === created.proposalId,
      );
    expect(await notice()).toBeDefined();
    const payload = { action, expectedVersion: expected.version, requestKey: randomUUID() };
    expect(
      (await app.inject({ method: 'POST', url, headers: headers(approver), payload })).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { ...headers(requester), 'x-csrf-token': 'invalid' },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    const post = () => app.inject({ method: 'POST', url, headers: headers(requester), payload });
    const settled = await post();
    const status = action === 'confirm_sent' ? 'done' : 'failed';
    expect(settled.statusCode).toBe(200);
    expect(settled.json()).toMatchObject({ status, action, replayed: false });
    expect((await post()).json()).toMatchObject({ status, action, replayed: true });
    expect(await processTestOutbound(database.pool, approved.queueId)).toMatchObject({
      status,
      attempts: 1,
      dispatchId: expected.dispatchId,
    });
    expect(await notice()).toBeUndefined();
    const recovered = (await app.inject({ url, headers: headers(requester) })).json();
    if (action === 'repropose')
      expect(recovered).toMatchObject({ status: 'failed', reproposeRecorded: true });
    else expect(recovered).toBeNull();
    const audit = (
      await database.pool.query(
        'SELECT actor_user_id,actor_kind FROM audit_log WHERE action=$1 AND target_id=$2',
        [`outbound.reconciliation.${action}`, approved.queueId],
      )
    ).rows;
    expect(audit).toEqual([{ actor_user_id: memberA.userId, actor_kind: 'browser' }]);
  },
);

test('查询已发送的数据库语句失败时保留发送记录并进入待对账', async () => {
  const created = await proposal();
  const approved = await approve(created.proposalId, await login());
  const connection = await database.pool.connect();
  let errorCode: unknown;
  const wrapped = new Proxy(connection, {
    get(target, key) {
      if (key === 'release') return () => undefined;
      if (key === 'query')
        return async (...args: unknown[]) => {
          if (
            typeof args[0] === 'string' &&
            args[0].startsWith('SELECT 1 FROM simulated_email_delivery d')
          ) {
            try {
              await target.query('SELECT 1 / 0');
            } catch (error) {
              errorCode = (error as { code?: string }).code;
              throw error;
            }
          }
          return Reflect.apply(target.query, target, args);
        };
      return Reflect.get(target, key);
    },
  }) as PoolClient;
  const pool = new Proxy(database.pool, {
    get(target, key) {
      return key === 'connect' ? async () => wrapped : Reflect.get(target, key);
    },
  });
  try {
    const failedLookup = await processTestOutbound(pool, approved.queueId, {
      simulate: 'uncertain',
      sentFolder: 'auto_store',
    });
    expect(errorCode).toBe('22012');
    expect(failedLookup).toMatchObject({ status: 'reconcile', attempts: 1 });
    expect(await processTestOutbound(database.pool, approved.queueId)).toEqual(failedLookup);
    expect(
      (
        await database.pool.query(
          'SELECT queue_id FROM simulated_email_delivery WHERE queue_id=$1',
          [approved.queueId],
        )
      ).rows,
    ).toEqual([{ queue_id: approved.queueId }]);
  } finally {
    connection.release();
  }
});

test('明确拒收提醒发起人，保持失败且不能确认已发出', async () => {
  const created = await proposal();
  const approved = await approve(created.proposalId, await login());
  const failed = await processTestOutbound(database.pool, approved.queueId, {
    simulate: 'failure',
    sentFolder: 'auto_store',
  });
  expect(failed).toMatchObject({ status: 'failed', attempts: 1, receipt: null });
  expect(await processTestOutbound(database.pool, approved.queueId)).toEqual(failed);
  expect((await readMemberNotifications(database.pool, memberA)).items).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: 'outbound', id: created.proposalId })]),
  );
  const requester = await login('zhangsan');
  const url = `/api/proposals/${created.proposalId}/reconciliation`;
  const { version } = (await app.inject({ url, headers: headers(requester) })).json();
  const confirmed = await app.inject({
    method: 'POST',
    url,
    headers: headers(requester),
    payload: { action: 'confirm_sent', expectedVersion: version, requestKey: randomUUID() },
  });
  expect(confirmed.statusCode).toBe(409);
  const retried = await app.inject({
    method: 'POST',
    url,
    headers: headers(requester),
    payload: { action: 'repropose', expectedVersion: version, requestKey: randomUUID() },
  });
  expect(retried.json()).toMatchObject({ status: 'failed', action: 'repropose' });
});

test('迁移前的待对账记录仍可查看，旧编号不再次执行', async () => {
  const created = await proposal();
  const approved = await approve(created.proposalId, await login());
  await database.pool.query(
    "UPDATE outbound_message SET status='reconcile',attempts=1,processed_at=clock_timestamp() WHERE id=$1",
    [approved.queueId],
  );
  await database.pool.query("UPDATE proposal SET status='reconcile' WHERE id=$1", [
    created.proposalId,
  ]);
  const requester = await login('zhangsan');
  const result = await app.inject({
    url: `/api/proposals/${created.proposalId}/reconciliation`,
    headers: headers(requester),
  });
  expect(result.json()).toMatchObject({
    status: 'reconcile',
    dispatchId: `<${approved.queueId}@cert-board.local>`,
  });
  expect(await processTestOutbound(database.pool, approved.queueId)).toMatchObject({
    status: 'reconcile',
    attempts: 1,
  });
  expect(
    (
      await database.pool.query('SELECT 1 FROM simulated_email_delivery WHERE queue_id=$1', [
        approved.queueId,
      ])
    ).rowCount,
  ).toBe(0);
});

test('已批准正文、审批记录和队列来源不能改写', async () => {
  const created = await proposal(),
    browser = await login();
  const approved = await approve(created.proposalId, browser);
  await expect(
    database.pool.query("UPDATE proposal SET body='替换正文' WHERE id=$1", [created.proposalId]),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    database.pool.query("UPDATE decision SET action='rejected' WHERE id=$1", [approved.decisionId]),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    database.pool.query('UPDATE outbound_message SET approved_version=99 WHERE id=$1', [
      approved.queueId,
    ]),
  ).rejects.toMatchObject({ code: '42501' });
  expect((await processTestOutbound(database.pool, approved.queueId)).status).toBe('done');
});

test('拒绝提案不会生成队列，生产环境及自定义sender均不可使用测试发送器', async () => {
  const created = await proposal(),
    browser = await login();
  const rejected = await app.inject({
    method: 'POST',
    url: `/api/proposals/${created.proposalId}/decision`,
    headers: headers(browser),
    payload: { expectedVersion: 1, action: 'rejected', requestKey: randomUUID() },
  });
  expect(rejected.statusCode).toBe(200);
  expect(rejected.json().queueId).toBeNull();
  const another = await proposal('second');
  const approved = await approve(another.proposalId, browser);
  const sender = vi.fn();
  await expect(
    processTestOutbound(database.pool, approved.queueId, {
      simulate: 'success',
      sender,
    } as unknown as { simulate: 'success' }),
  ).rejects.toMatchObject({ statusCode: 400 });
  expect(sender.mock.calls.length).toBe(0);
  vi.stubEnv('NODE_ENV', 'production');
  await expect(processTestOutbound(database.pool, approved.queueId)).rejects.toMatchObject({
    statusCode: 403,
  });
});
