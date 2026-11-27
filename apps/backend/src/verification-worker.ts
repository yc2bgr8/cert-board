import { parseBackendConfig, selectGatewayModel } from '@cert-board/shared';
import { readFile } from 'node:fs/promises';
import { createDependencies } from './dependencies.js';
import { BlobStore } from './documents/blob-store.js';
import { FetcherClient } from './documents/fetcher-client.js';
import { createVerificationSourceChecker } from './external-model/source-verification.js';
import { startVerificationWorker } from './external-model/verification-worker.js';
import { createLogger } from './logger.js';
import { loadVerificationModelGatewayConfig, parseAllowedModelHosts } from './modelgw/config.js';
import { ModelGateway } from './modelgw/service.js';
import { createWorkerModelTransport } from './modelgw/transport.js';
import { readCursorAcceptanceConfig } from './modelgw/cursor-acceptance.js';

async function start() {
  const config = parseBackendConfig(process.env);
  if (config.NODE_ENV !== 'development') throw new Error('VERIFICATION_LOCAL_WORKER_ONLY');
  const logger = createLogger(config);
  const dependencies = createDependencies(config);
  const proxyUrl = process.env.HTTPS_PROXY;
  const cursorAcceptance = await readCursorAcceptanceConfig(config.NODE_ENV);
  const moderatorUnavailable = () => {
    logger.warn(
      { event: 'verification_moderator_model_unavailable' },
      '核实主持使用本地程序，模型配置暂不可用。',
    );
    return undefined;
  };
  const models = await loadVerificationModelGatewayConfig({
    environment: config.NODE_ENV,
    allowCursorAcceptance: cursorAcceptance !== undefined,
  }).catch(moderatorUnavailable);
  const remoteProxy = proxyUrl && process.env.OPENROUTER_API_KEY ? proxyUrl : undefined;
  let transport: ReturnType<typeof createWorkerModelTransport> | undefined;
  if (models) {
    try {
      const allowedHosts = parseAllowedModelHosts(
        await readFile(new URL('../../../deploy/egress/allowlist', import.meta.url), 'utf8'),
      );
      transport = createWorkerModelTransport(models, {
        ...(remoteProxy ? { proxyUrl: remoteProxy } : {}),
        allowedHosts,
        ...(cursorAcceptance && { cursorAcceptance }),
      });
    } catch {
      moderatorUnavailable();
    }
  }
  const gateway =
    transport && models
      ? new ModelGateway(dependencies.database, models, transport, { environment: config.NODE_ENV })
      : undefined;
  const checker = process.env.CERT_FETCHER_URL
    ? createVerificationSourceChecker(
        dependencies.database,
        new BlobStore(dependencies.storage, config.MINIO_BUCKET),
        new FetcherClient(process.env.CERT_FETCHER_URL, config.CONTAINER_RUNTIME),
        (process.env.CERT_WEB_EXTENDED_HOSTS ?? '')
          .split(',')
          .map((host) => host.trim().toLowerCase())
          .filter(Boolean),
      )
    : undefined;
  const selected = models && selectGatewayModel(models, 'agent');
  const dispose = await startVerificationWorker(
    dependencies.database,
    logger,
    process.env,
    gateway,
    checker,
    selected?.transport === 'local' ? selected.id : undefined,
    (remoteProxy || cursorAcceptance) && models ? selectGatewayModel(models, 'verification')?.id : undefined,
  );
  let closed = false;
  function shutdown() {
    if (closed) return;
    closed = true;
    void dispose()
      .then(() => transport?.close())
      .then(() => dependencies.close())
      .catch(() => {
        process.exitCode = 1;
      });
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

start().catch(() => {
  console.error('外部核实进程未能启动，请检查开发配置和数据库迁移。');
  process.exitCode = 1;
});
