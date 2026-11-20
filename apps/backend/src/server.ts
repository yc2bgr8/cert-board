import { existsSync } from 'node:fs';
import { ConfigurationError, parseBackendConfig } from '@cert-board/shared';
import { createApp } from './app.js';
import { AppError } from './api/errors.js';

function installPreviewDrain(app: ReturnType<typeof createApp>) {
  let draining = false;
  const pending = new Set<string>();
  app.addHook('onRequest', async (request) => {
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS')
      return;
    if (draining) throw new AppError(503, 'PREVIEW_UPDATING', '预览正在切换版本，请稍后重试。');
    pending.add(request.id);
  });
  app.addHook('onResponse', async (request) => {
    pending.delete(request.id);
  });
  process.on('message', (message) => {
    if (message === 'preview-resume') draining = false;
    if (message === 'preview-drain') {
      draining = true;
      process.send?.({ type: 'preview-drain', pending: pending.size });
    }
  });
}

async function startApi() {
  const config = parseBackendConfig(process.env);
  if (config.HOST === '0.0.0.0' && !existsSync('/.dockerenv'))
    throw new Error('接口仅在 Docker 内部可监听容器网卡');
  const app = createApp(config);
  const previewInstance = process.env.CERT_PREVIEW_INSTANCE;
  if (previewInstance && /^[0-9a-f-]{36}$/u.test(previewInstance)) {
    app.addHook('onSend', async (_request, reply, payload) => {
      reply.header('x-cert-preview-instance', previewInstance);
      return payload;
    });
  }
  if (config.WEB_ORIGIN === 'http://127.0.0.1:28380' && process.send) installPreviewDrain(app);
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
