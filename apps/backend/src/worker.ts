import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PgBoss } from 'pg-boss';
import { ConfigurationError, parseBackendConfig } from '@cert-board/shared';
import { createLogger } from './logger.js';
import { createDependencies } from './dependencies.js';
import { BlobStore } from './documents/blob-store.js';
import { loadModelGatewayConfig, parseAllowedModelHosts } from './modelgw/config.js';
import { ModelGateway } from './modelgw/service.js';
import { RealGatewayTransport } from './modelgw/transport.js';
import { buildAgentTools } from './agent/default-tools.js';
import { executeAgentRun } from './agent/runtime.js';
import {
  AGENT_QUEUE,
  createAgentQueue,
  consumeAgentRuns,
  enqueueAgentRun,
  finishAbandonedAgentRun,
  recoverAbandonedAgentRuns,
} from './queue/agent-queue.js';
import { handoffBlockedBudgetRuns, markUsageIncomplete } from './budget/service.js';
import { purgeExpiredModelRequests } from './runs/request-retention.js';

export async function startWorker() {
  const config = parseBackendConfig(process.env);
  const logger = createLogger(config);
  let dependencies: ReturnType<typeof createDependencies> | undefined;
  let transport: RealGatewayTransport | undefined;
  let boss: PgBoss | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let maintenance: Promise<void> | undefined;
  let registration: Promise<string> | undefined;
  let stopPromise: Promise<void> | undefined;
  let closing = false;
  const active = new Map<string, AbortController>();
  const tasks = new Set<Promise<void>>();
  const stop = () =>
    (stopPromise ??= (async () => {
      closing = true;
      if (interval) clearInterval(interval);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      for (const controller of active.values()) controller.abort();
      let failed = false;
      if (registration) await registration.catch(() => undefined);
      if (boss)
        await boss.stop({ graceful: true, timeout: 20_000 }).catch(() => {
          failed = true;
        });
      // 队列自身超时后可能放弃等待；业务和维护须退出才能关闭共享连接。
      await Promise.allSettled([...tasks, ...(maintenance ? [maintenance] : [])]);
      if (transport)
        await transport.close().catch(() => {
          failed = true;
        });
      if (dependencies)
        await dependencies.close().catch(() => {
          failed = true;
        });
      logger.info({ event: 'worker_stopped' }, '后台进程已停止。');
      if (failed) throw new Error('WORKER_CLEANUP_FAILED');
    })());
  const onSignal = () => {
    void stop().catch(() => {
      console.error('后台进程资源清理未全部完成，请核对本地服务。');
      process.exitCode = 1;
    });
  };
  try {
    dependencies = createDependencies(config);
    const resources = dependencies;
    const models = await loadModelGatewayConfig({ environment: config.NODE_ENV });
    const allowedHosts = parseAllowedModelHosts(
      await readFile(new URL('../../../deploy/egress/allowlist', import.meta.url), 'utf8'),
    );
    transport = new RealGatewayTransport({ proxyUrl: process.env.HTTPS_PROXY ?? '', allowedHosts });
    const gateway = new ModelGateway(resources.database, models, transport, {
      environment: config.NODE_ENV,
    });
    const definitions = await buildAgentTools();
    const store = new BlobStore(resources.storage, config.MINIO_BUCKET);
    const reconcile = async () => {
      await recoverAbandonedAgentRuns(resources.database);
      const orphaned = await resources.database.query<{
        request_key: string;
        run_id: string;
        user_id: string;
      }>(
        `SELECT l.request_key,l.run_id,l.user_id FROM usage_ledger l JOIN run r ON r.id=l.run_id
         WHERE l.status='reserved' AND r.status IN ('stopped','failed','completed','budget_exhausted') LIMIT 100`,
      );
      for (const row of orphaned.rows)
        await markUsageIncomplete(resources.database, {
          requestKey: row.request_key,
          runId: row.run_id,
          userId: row.user_id,
          reasonCode: 'request_uncertain',
        });
      await handoffBlockedBudgetRuns(resources.database);
    };
    await reconcile();
    boss = await createAgentQueue(config.DATABASE_URL, () =>
      logger.error({ event: 'queue_error' }, '任务队列暂不可用，请核对本地服务。'),
    );
    const queue = boss;
    const dispatchQueued = async () => {
      const queued = await resources.database.query<{ id: string }>(
        "SELECT id FROM run WHERE status='queued' AND lease_generation=0 AND lease_owner IS NULL ORDER BY created_at,id LIMIT 100",
      );
      for (const row of queued.rows) {
        if (closing) break;
        const id = await enqueueAgentRun(queue, row.id);
        if (!id) {
          const job = await queue.getJobById(AGENT_QUEUE, row.id);
          if (job && ['failed', 'completed', 'cancelled'].includes(job.state))
            await finishAbandonedAgentRun(resources.database, row.id, true);
        }
      }
    };
    await dispatchQueued();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    registration = consumeAgentRuns(
      queue,
      async (runId, jobSignal) => {
        if (active.has(runId)) return;
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (closing || jobSignal.aborted) abort();
        jobSignal.addEventListener('abort', abort, { once: true });
        active.set(runId, controller);
        const task = (async () => {
          try {
            if (closing || controller.signal.aborted) throw new Error('worker_stopping');
            const before = (
              await resources.database.query<{ status: string; lease_generation: string }>(
                'SELECT status,lease_generation FROM run WHERE id=$1',
                [runId],
              )
            ).rows[0];
            if (!before || before.status !== 'queued') {
              await finishAbandonedAgentRun(resources.database, runId);
              return;
            }
            if (BigInt(before.lease_generation) !== 0n) throw new Error('run_already_started');
            const result = await executeAgentRun(
              { pool: resources.database, store, gateway, models, definitions },
              runId,
              { signal: controller.signal },
            );
            if (result.status === 'queued') throw new Error('run_not_started');
            const recovered =
              result.status === 'running' &&
              (await finishAbandonedAgentRun(resources.database, runId));
            logger.info(
              { event: 'agent_run_finished', runId, status: recovered ? 'stopped' : result.status },
              '运行状态已记录。',
            );
          } catch {
            await finishAbandonedAgentRun(resources.database, runId, true).catch(() => undefined);
            logger.warn(
              { event: 'agent_run_failed', runId },
              '运行未完成，请核对执行记录；不会自动重发模型。',
            );
            throw new Error('AGENT_JOB_FAILED');
          } finally {
            active.delete(runId);
            jobSignal.removeEventListener('abort', abort);
          }
        })();
        tasks.add(task);
        try {
          await task;
        } finally {
          tasks.delete(task);
        }
      },
      () => closing,
      async (runId) => {
        await finishAbandonedAgentRun(resources.database, runId, true);
      },
    );
    await registration;
    if (closing) {
      await stop();
      throw new Error('WORKER_START_CANCELLED');
    }
    interval = setInterval(() => {
      logger.info({ event: 'worker_heartbeat' }, '后台进程心跳');
      if (maintenance || closing) return;
      maintenance = (async () => {
        await reconcile();
        if (!closing) await dispatchQueued();
        await purgeExpiredModelRequests(resources.database);
      })()
        .catch(() => logger.warn({ event: 'maintenance_deferred' }, '后台维护暂未完成，稍后重试。'))
        .finally(() => {
          maintenance = undefined;
        });
    }, 30_000);
    logger.info({ event: 'worker_ready' }, '后台运行器已就绪。');
    return { stop };
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startWorker().catch((error: unknown) => {
    console.error(
      error instanceof ConfigurationError ? error.message : '后台进程启动失败，请检查配置。',
    );
    process.exitCode = 1;
  });
}
