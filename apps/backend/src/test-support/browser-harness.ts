import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { PgBoss } from 'pg-boss';
import {
  browserContentSecurityPolicy,
  browserReferrerPolicy,
  parseBackendConfig,
} from '@cert-board/shared';
import { createTestDatabase } from '../db/test-database.js';
import { migrateDatabase } from '../db/migrate.js';
import { seedDevelopmentAccounts } from '../db/seed.js';
import {
  seedDevelopmentProject,
  developmentProjectId,
  developmentGoalId,
} from '../projects/seed.js';
import { seedDevelopmentWorkspace } from '../workspace/seed.js';
import { seedDevelopmentBudgetPolicy } from '../budget/service.js';
import { ingestParsedDocument } from '../documents/service.js';
import { readT1Fixture } from '../documents/t1-seed.js';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import { createApp } from '../app.js';
import {
  createAgentQueue,
  consumeAgentRuns,
  enqueueAgentRun,
  finishAbandonedAgentRun,
} from '../queue/agent-queue.js';
import { listContinuationsForDispatch } from '../approvals/continuation.js';
import { ModelGateway } from '../modelgw/service.js';
import { executeAgentRun } from '../agent/runtime.js';
import { buildAgentTools } from '../agent/default-tools.js';
import { setTestReminderClock } from './internal-reminder-clock.js';
import {
  browserModels,
  browserScenario,
  type BrowserFixtureControl,
  type BrowserScenario,
} from './browser-fixture.js';

const origin = 'http://127.0.0.1:28080';
class MemoryStore implements DocumentBlobStore {
  private values = new Map<string, Buffer>();
  async put(value: Buffer) {
    const sha256 = createHash('sha256').update(value).digest('hex');
    this.values.set(sha256, Buffer.from(value));
    return { sha256, byteSize: value.length };
  }
  async get(sha256: string) {
    const value = this.values.get(sha256);
    if (!value) throw new Error('BROWSER_BLOB_MISSING');
    return Buffer.from(value);
  }
}

export async function startBrowserHarness() {
  if (process.env.NODE_ENV !== 'test') throw new Error('BROWSER_HARNESS_TEST_ONLY');
  const dist = fileURLToPath(new URL('../../../web/dist/', import.meta.url));
  let index: Buffer;
  try {
    index = await readFile(path.join(dist, 'index.html'));
  } catch {
    throw new Error('BROWSER_BUILD_REQUIRED');
  }
  const database = await createTestDatabase();
  const pool = database.pool;
  let app: ReturnType<typeof createApp> | undefined;
  let boss: PgBoss | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let dispatching: Promise<void> | undefined;
  let closing = false;
  let closed: Promise<void> | undefined;
  const active = new Map<string, AbortController>();
  const jobs = new Set<Promise<void>>();
  const planned: BrowserFixtureControl[] = [];
  const scenarios = new Map<string, BrowserFixtureControl>();
  let workerFailed = false;
  const workerFailures = new Set<string>();
  pool.on('error', () => {
    workerFailed = true;
    workerFailures.add('POOL');
  });
  const stop = () =>
    (closed ??= (async () => {
      closing = true;
      if (timer) clearInterval(timer);
      for (const controller of active.values()) controller.abort();
      for (const control of [...planned, ...scenarios.values()]) control.release();
      await dispatching?.catch(() => undefined);
      let failed = false;
      await boss?.stop({ graceful: true, timeout: 20000 }).catch(() => {
        failed = true;
      });
      await Promise.allSettled([...jobs]);
      await app?.close().catch(() => {
        failed = true;
      });
      await database.dispose().catch(() => {
        failed = true;
      });
      if (failed) throw new Error('BROWSER_CLEANUP_FAILED');
    })());
  try {
    const name = (await pool.query<{ name: string }>('SELECT current_database() AS name')).rows[0]!
      .name;
    if (!/^cert_[a-f0-9]{24}_test$/.test(name)) throw new Error('BROWSER_DATABASE_REFUSED');
    await migrateDatabase(pool);
    const passwords = Object.fromEntries(
      ['zhangsan', 'wangmin', 'admin'].map((username) => [
        username,
        randomBytes(24).toString('base64url'),
      ]),
    );
    await seedDevelopmentAccounts(pool, {
      NODE_ENV: 'test',
      DEV_ZHANGSAN_PASSWORD: passwords.zhangsan,
      DEV_WANGMIN_PASSWORD: passwords.wangmin,
      DEV_ADMIN_PASSWORD: passwords.admin,
    });
    await seedDevelopmentProject(pool, { NODE_ENV: 'test' });
    const store = new MemoryStore();
    const fixture = await readT1Fixture();
    const source = fixture.documents.find((document) => document.id === 'D035')!;
    await ingestParsedDocument(pool, store, {
      projectId: developmentProjectId,
      sourceKey: source.id,
      name: source.name,
      sourcePath: source.path,
      sourceSnapshot: fixture.snapshot,
      originalSha256: source.sha256,
      dataLevel: 'internal',
      authorType: 'external',
      sourceMetadata: {},
      pages: fixture.pages
        .filter((page) => page.doc === source.id)
        .map((page) => ({
          pageNumber: page.page,
          text: page.text,
          method: page.method,
          locatorKind: page.method === 'docx' ? 'extraction_unit' : 'physical_page',
          ocrScore: page.ocr_score ?? null,
          isPlaceholder: false,
        })),
    });
    await seedDevelopmentWorkspace(pool, store, { NODE_ENV: 'test' });
    await seedDevelopmentBudgetPolicy(pool, 'test');
    await setTestReminderClock(pool);
    const users = (
      await pool.query<{ id: string; username: string }>('SELECT id,username FROM app_user')
    ).rows;
    const userId = (username: string) => users.find((user) => user.username === username)!.id;
    const contactId = (
      await pool.query<{ id: string }>(
        `INSERT INTO contact(project_id,name,address,source,created_by,internal_user_id)
       VALUES($1,'王敏','local-test-browser','浏览器验收可信开发绑定',$2,$3) RETURNING id`,
        [developmentProjectId, userId('zhangsan'), userId('wangmin')],
      )
    ).rows[0]!.id;
    const adminContactId = (
      await pool.query<{ id: string }>(
        `INSERT INTO contact(project_id,name,address,source,created_by,internal_user_id)
       VALUES($1,'李晨','local-test-browser-admin','浏览器验收可信开发绑定',$2,$3) RETURNING id`,
        [developmentProjectId, userId('zhangsan'), userId('admin')],
      )
    ).rows[0]!.id;
    const sharedConversationId = (
      await pool.query<{ id: string }>(
        `INSERT INTO conversation(project_id,user_id,goal_id,title,permission_mode,agent_code)
       VALUES($1,$2,$3,'王敏的资料核对','read_only','registration') RETURNING id`,
        [developmentProjectId, userId('wangmin'), developmentGoalId],
      )
    ).rows[0]!.id;
    const config = parseBackendConfig({
      ...process.env,
      NODE_ENV: 'test',
      WEB_ORIGIN: origin,
      LOG_LEVEL: 'silent',
    });
    app = createApp(config, {
      database: pool,
      blobStore: store,
      checkDatabase: async () => {
        await pool.query('SELECT 1');
      },
      checkStorage: async () => undefined,
      close: async () => undefined,
    });
    app.addHook('onSend', async (_request, reply, payload) => {
      reply.header('content-security-policy', browserContentSecurityPolicy);
      reply.header('referrer-policy', browserReferrerPolicy);
      return payload;
    });
    app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(index));
    app.get('/favicon.svg', async (_request, reply) =>
      reply.type('image/svg+xml').send(await readFile(path.join(dist, 'favicon.svg'))),
    );
    app.get('/assets/:file', async (request, reply) => {
      const file = (request.params as { file: string }).file;
      if (!/^[A-Za-z0-9_.-]+\.(?:js|css|woff2?|svg|png)$/.test(file)) return reply.code(404).send();
      const contentTypes: Record<string, string> = {
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
      };
      const type = contentTypes[path.extname(file)]!;
      try {
        return reply.type(type).send(await readFile(path.join(dist, 'assets', file)));
      } catch {
        return reply.code(404).send();
      }
    });
    await app.listen({ host: '127.0.0.1', port: 28080 });
    const connection = pool.options.connectionString;
    if (typeof connection !== 'string' || new URL(connection).pathname !== `/${name}`)
      throw new Error('BROWSER_QUEUE_DATABASE_REFUSED');
    boss = await createAgentQueue(connection, () => {
      workerFailed = true;
      workerFailures.add('QUEUE');
    });
    const queue = boss;
    await consumeAgentRuns(
      queue,
      async (runId, signal, ticketId) => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted || closing) abort();
        active.set(runId, controller);
        const task = (async () => {
          const scenario = scenarios.get(runId) ?? planned.shift();
          if (!scenario) throw new Error('BROWSER_SCENARIO_MISSING');
          scenarios.set(runId, scenario);
          const gateway = new ModelGateway(pool, browserModels, scenario.transport, {
            environment: 'test',
          });
          await executeAgentRun(
            {
              pool,
              store,
              gateway,
              models: browserModels,
              definitions: (code) => buildAgentTools(store, code),
            },
            runId,
            { signal: controller.signal, ...(ticketId ? { ticketId } : {}) },
          );
        })();
        jobs.add(task);
        try {
          await task;
        } finally {
          jobs.delete(task);
          active.delete(runId);
          signal.removeEventListener('abort', abort);
        }
      },
      () => closing,
      async (runId, ticketId) => {
        workerFailed = true;
        workerFailures.add('JOB');
        await finishAbandonedAgentRun(pool, runId, true, ticketId);
      },
    );
    const dispatch = async () => {
      const queued = (
        await pool.query<{ id: string }>(
          "SELECT id FROM run WHERE status='queued' AND trigger_type='conversation' AND lease_generation=0 ORDER BY created_at,id LIMIT 20",
        )
      ).rows;
      for (const run of queued) if (!closing) await enqueueAgentRun(queue, run.id);
      for (const ticket of await listContinuationsForDispatch(pool))
        if (!closing) await enqueueAgentRun(queue, ticket.runId, ticket.id);
    };
    timer = setInterval(() => {
      if (closing || dispatching) return;
      dispatching = dispatch()
        .catch(() => {
          workerFailed = true;
          workerFailures.add('DISPATCH');
        })
        .finally(() => {
          dispatching = undefined;
        });
    }, 100);
    return {
      origin,
      pool,
      projectId: developmentProjectId,
      sharedConversationId,
      credentials: { username: 'zhangsan', password: passwords.zhangsan! },
      plan(kind: BrowserScenario, recipient: 'wangmin' | 'admin' = 'wangmin') {
        const scenario = browserScenario(kind, recipient === 'admin' ? adminContactId : contactId);
        planned.push(scenario);
        return scenario;
      },
      healthy: () =>
        !workerFailed && [...scenarios.values()].every((scenario) => !scenario.observed.failed),
      diagnostics: () => ({
        workerFailures: [...workerFailures],
        scenarios: [...scenarios.values()].map((item) => ({
          kind: item.kind,
          calls: item.observed.calls,
          failed: item.observed.failed,
        })),
      }),
      disconnectStreams() {
        app!.server.closeAllConnections();
      },
      close: stop,
    };
  } catch (error) {
    await stop().catch(() => undefined);
    // eslint-disable-next-line preserve-caught-error -- 原始异常可能含连接信息，测试边界只输出固定安全码。
    throw new Error(
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'EADDRINUSE'
        ? 'BROWSER_PORT_IN_USE'
        : error instanceof Error && /^BROWSER_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'BROWSER_HARNESS_START_FAILED',
    );
  }
}
