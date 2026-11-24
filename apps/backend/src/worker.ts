import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PgBoss } from 'pg-boss';
import { ConfigurationError, parseBackendConfig, type AgentCode } from '@cert-board/shared';
import { createLogger } from './logger.js';
import { createDependencies } from './dependencies.js';
import { BlobStore } from './documents/blob-store.js';
import { FetcherClient } from './documents/fetcher-client.js';
import { loadModelGatewayConfig, parseAllowedModelHosts } from './modelgw/config.js';
import { ModelGateway } from './modelgw/service.js';
import { createWorkerModelTransport, type RealGatewayTransport } from './modelgw/transport.js';
import { buildAgentTools } from './agent/default-tools.js';
import { buildWebTools } from './tools/web-tools.js';
import { executeAgentRun } from './agent/runtime.js';
import { startDeadlineQueue } from './deadlines/queue.js';
import { DocumentParserClient, maximumDocumentBytes } from './documents/docsvc-client.js';
import { startDocumentParseWorker } from './documents/parse-tasks.js';
import { maximumIntakeBytes } from './intake/archive.js';
import { startIntakeWorker } from './intake/service.js';
import { SandboxClient } from './sandbox/client.js';
import { getContinuationTicket, listContinuationsForDispatch } from './approvals/continuation.js';
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
import {
  advanceVerificationDeadlines,
  listVerificationResumes,
  scanReadyVerificationWaits,
  scanReviewVerificationResults,
  scanVerificationNotices,
} from './goals/verification-wakeups.js';
import { scanGoalEvents, scanReviewDecisionEvents } from './goals/goal-events.js';
import { scanSkillRollbackProposals } from './skills/rollback.js';
import { scanOpsAlerts } from './ops/service.js';

export async function startWorker() {
  const config = parseBackendConfig(process.env);
  const logger = createLogger(config);
  let dependencies: ReturnType<typeof createDependencies> | undefined;
  let transport: RealGatewayTransport | undefined;
  let boss: PgBoss | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let dispatchInterval: ReturnType<typeof setInterval> | undefined;
  let dispatch: Promise<void> | undefined;
  let maintenance: Promise<void> | undefined;
  let opsScan: Promise<void> | undefined;
  const opsAbort = new AbortController();
  let registration: Promise<string> | undefined;
  let stopPromise: Promise<void> | undefined;
  let stopDocumentWorker: (() => Promise<void>) | undefined;
  let stopPackageWorker: (() => Promise<void>) | undefined;
  let closing = false;
  const active = new Map<string, AbortController>();
  const tasks = new Set<Promise<void>>();
  const stop = () =>
    (stopPromise ??= (async () => {
      closing = true;
      opsAbort.abort();
      if (interval) clearInterval(interval);
      if (dispatchInterval) clearInterval(dispatchInterval);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      for (const controller of active.values()) controller.abort();
      let failed = false;
      if (stopPackageWorker)
        await stopPackageWorker().catch(() => {
          failed = true;
        });
      if (stopDocumentWorker)
        await stopDocumentWorker().catch(() => {
          failed = true;
        });
      if (registration) await registration.catch(() => undefined);
      if (boss)
        await boss.stop({ graceful: true, timeout: 20_000 }).catch(() => {
          failed = true;
        });
      // 队列自身超时后可能放弃等待；业务和维护须退出才能关闭共享连接。
      await Promise.allSettled([
        ...tasks,
        ...(maintenance ? [maintenance] : []),
        ...(opsScan ? [opsScan] : []),
        ...(dispatch ? [dispatch] : []),
      ]);
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
    transport = createWorkerModelTransport(models, {
      ...(process.env.HTTPS_PROXY ? { proxyUrl: process.env.HTTPS_PROXY } : {}),
      containerRuntime: config.CONTAINER_RUNTIME,
      allowedHosts,
    });
    const gateway = new ModelGateway(resources.database, models, transport, {
      environment: config.NODE_ENV,
    });
    const store = new BlobStore(resources.storage, config.MINIO_BUCKET);
    const ruleSources = config.CERT_DOCSVC_URL
      ? {
          store: new BlobStore(resources.storage, config.MINIO_BUCKET, maximumDocumentBytes),
          parser: new DocumentParserClient(config.CERT_DOCSVC_URL, config.CONTAINER_RUNTIME),
        }
      : undefined;
    if (ruleSources) {
      const { store: originalStore, parser } = ruleSources;
      const packageStore = new BlobStore(
        resources.storage,
        config.MINIO_BUCKET,
        maximumIntakeBytes,
      );
      stopDocumentWorker = startDocumentParseWorker(resources.database, originalStore, parser, () =>
        logger.warn({ event: 'document_parse_deferred' }, '暂未能处理资料解析任务，稍后再试。'),
      );
      stopPackageWorker = startIntakeWorker(
        resources.database,
        packageStore,
        originalStore,
        parser,
        () => logger.warn({ event: 'intake_deferred' }, '暂未能领取整包导入任务，稍后再试。'),
      );
    }
    const webTools = process.env.CERT_FETCHER_URL
      ? buildWebTools(
          resources.database,
          store,
          new FetcherClient(process.env.CERT_FETCHER_URL, config.CONTAINER_RUNTIME),
          (process.env.CERT_WEB_EXTENDED_HOSTS ?? '')
            .split(',')
            .map((host) => host.trim().toLowerCase())
            .filter(Boolean),
        )
      : [];
    const sandbox = config.CERT_SANDBOX_URL
      ? new SandboxClient(config.CERT_SANDBOX_URL, config.CONTAINER_RUNTIME)
      : undefined;
    const definitions = async (code: AgentCode) => [
      ...(await buildAgentTools(
        store,
        code,
        resources.database,
        config.CONTAINER_RUNTIME,
        sandbox,
        ruleSources,
      )),
      ...webTools,
    ];
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
    boss = await createAgentQueue(
      config.DATABASE_URL,
      () => logger.error({ event: 'queue_error' }, '任务队列暂不可用，请核对本地服务。'),
      true,
    );
    const queue = boss;
    await startDeadlineQueue(queue, resources.database);
    const dispatchQueued = async () => {
      const queued = await resources.database.query<{ id: string }>(
        `SELECT id FROM run WHERE status='queued' AND trigger_type<>'evaluation' AND lease_generation=0 AND lease_owner IS NULL
         AND NOT EXISTS(SELECT 1 FROM verification_wait w WHERE w.run_id=run.id AND (w.state='queued' OR w.call_id IS NULL)) ORDER BY created_at,id LIMIT 100`,
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
      if (closing) return;
      for (const ticket of await listContinuationsForDispatch(resources.database)) {
        if (closing) break;
        const id = await enqueueAgentRun(queue, ticket.runId, ticket.id);
        if (!id) {
          const job = await queue.getJobById(AGENT_QUEUE, ticket.id);
          if (job && ['failed', 'completed', 'cancelled'].includes(job.state))
            await finishAbandonedAgentRun(resources.database, ticket.runId, true, ticket.id);
        }
      }
      if (closing) return;
      await advanceVerificationDeadlines(resources.database);
      await scanVerificationNotices(resources.database);
      await scanReadyVerificationWaits(resources.database);
      await scanReviewVerificationResults(resources.database);
      await scanGoalEvents(resources.database);
      await scanReviewDecisionEvents(resources.database);
      for (const resume of await listVerificationResumes(resources.database)) {
        if (closing) break;
        const id = await enqueueAgentRun(queue, resume.runId, undefined, resume.roomId);
        if (!id) {
          const job = await queue.getJobById(AGENT_QUEUE, resume.roomId);
          if (job && ['failed', 'completed', 'cancelled'].includes(job.state))
            await finishAbandonedAgentRun(
              resources.database,
              resume.runId,
              true,
              undefined,
              resume.roomId,
            );
        }
      }
    };
    await dispatchQueued();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    registration = consumeAgentRuns(
      queue,
      async (runId, jobSignal, ticketId, queueExpiresAtMs, verificationId) => {
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
            if (ticketId) {
              const ticket = await getContinuationTicket(resources.database, ticketId);
              if (!ticket || ticket.runId !== runId || ticket.state !== 'queued') return;
            } else if (!verificationId && BigInt(before.lease_generation) !== 0n) return;
            const result = await executeAgentRun(
              { pool: resources.database, store, gateway, models, definitions },
              runId,
              {
                signal: controller.signal,
                queueExpiresAtMs,
                ...(ticketId ? { ticketId } : {}),
                ...(verificationId ? { verificationId } : {}),
              },
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
            await finishAbandonedAgentRun(
              resources.database,
              runId,
              true,
              ticketId,
              verificationId,
            ).catch(() => undefined);
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
      async (runId, ticketId, verificationId) => {
        await finishAbandonedAgentRun(resources.database, runId, true, ticketId, verificationId);
      },
    );
    await registration;
    if (closing) {
      await stop();
      throw new Error('WORKER_START_CANCELLED');
    }
    let databaseAvailable: boolean | undefined;
    const observeOpsDatabase = (available: boolean) => {
      if (!available && databaseAvailable !== false) {
        logger.warn({ event: 'ops_database_unavailable' }, '本机数据库探测失败。');
      } else if (available && databaseAvailable === false) {
        logger.info({ event: 'ops_database_recovered' }, '本机数据库探测已恢复。');
      }
      databaseAvailable = available;
    };
    const refreshOps = () => {
      if (closing || opsScan) return;
      opsScan = scanOpsAlerts(resources.database, config, resources, webTools.length > 0, {
        signal: opsAbort.signal,
        onDatabase: observeOpsDatabase,
      })
        .then((opened) => {
          for (const { key, level } of opened) {
            logger.warn({ event: 'ops_alert_opened', key, level }, '已记录本机运维告警。');
          }
        })
        .catch(() => {
          if (!closing)
            logger.warn({ event: 'ops_scan_deferred' }, '本机运维检查暂未完成，后台会重试。');
        })
        .finally(() => {
          opsScan = undefined;
        });
    };
    dispatchInterval = setInterval(() => {
      if (dispatch || closing) return;
      dispatch = dispatchQueued()
        .catch(() =>
          logger.warn({ event: 'dispatch_deferred' }, '后台暂未能领取待执行任务，稍后再次检查。'),
        )
        .finally(() => {
          dispatch = undefined;
        });
    }, 1_000);
    interval = setInterval(() => {
      logger.info({ event: 'worker_heartbeat' }, '后台进程心跳');
      refreshOps();
      if (maintenance || closing) return;
      maintenance = (async () => {
        await reconcile();
        await purgeExpiredModelRequests(resources.database);
        await scanSkillRollbackProposals(resources.database);
      })()
        .catch(() => logger.warn({ event: 'maintenance_deferred' }, '后台维护暂未完成，稍后重试。'))
        .finally(() => {
          maintenance = undefined;
        });
    }, 30_000);
    refreshOps();
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
