import { parseBackendConfig, selectGatewayModel } from '@cert-board/shared';
import { readFile } from 'node:fs/promises';
import { createDependencies } from './dependencies.js';
import { startVerificationWorker } from './external-model/verification-worker.js';
import { createLogger } from './logger.js';
import { loadModelGatewayConfig, parseAllowedModelHosts } from './modelgw/config.js';
import { ModelGateway } from './modelgw/service.js';
import { RealGatewayTransport } from './modelgw/transport.js';

async function start() {
  const config = parseBackendConfig(process.env);
  if (config.NODE_ENV !== 'development') throw new Error('VERIFICATION_LOCAL_WORKER_ONLY');
  const logger = createLogger(config);
  const dependencies = createDependencies(config);
  const proxyUrl = process.env.HTTPS_PROXY;
  const models = await loadModelGatewayConfig({ environment: config.NODE_ENV });
  const localReady = selectGatewayModel(models, 'agent')?.transport === 'local';
  const remoteProxy = proxyUrl && process.env.OPENROUTER_API_KEY ? proxyUrl : undefined;
  const transport =
    localReady || remoteProxy
      ? new RealGatewayTransport({
          ...(remoteProxy ? { proxyUrl: remoteProxy } : {}),
          allowedHosts: parseAllowedModelHosts(
            await readFile(new URL('../../../deploy/egress/allowlist', import.meta.url), 'utf8'),
          ),
        })
      : undefined;
  const gateway = transport
    ? new ModelGateway(dependencies.database, models, transport, { environment: config.NODE_ENV })
    : undefined;
  const dispose = await startVerificationWorker(
    dependencies.database,
    logger,
    process.env,
    gateway,
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
