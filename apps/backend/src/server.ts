import { existsSync } from 'node:fs';
import { ConfigurationError, parseBackendConfig } from '@cert-board/shared';
import { createApp } from './app.js';

async function startApi() {
  const config = parseBackendConfig(process.env);
  if (config.HOST === '0.0.0.0' && !existsSync('/.dockerenv'))
    throw new Error('接口仅在 Docker 内部可监听容器网卡');
  const app = createApp(config);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await app.close();
    } catch {
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  try {
    await app.listen({ host: config.HOST, port: config.PORT });
    app.log.info({ event: 'api_started', port: config.PORT }, '接口服务已启动');
  } catch {
    await stop();
    throw new Error('接口服务启动失败');
  }
}

startApi().catch((error: unknown) => {
  console.error(
    error instanceof ConfigurationError
      ? error.message
      : '接口服务启动失败，请检查配置和端口占用。',
  );
  process.exitCode = 1;
});
