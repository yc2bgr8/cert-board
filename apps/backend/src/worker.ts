import { ConfigurationError, parseBackendConfig } from '@cert-board/shared';
import { createLogger } from './logger.js';

try {
  const config = parseBackendConfig(process.env);
  const logger = createLogger(config);
  const heartbeat = () => logger.info({ event: 'worker_heartbeat' }, '后台进程心跳');
  heartbeat();
  const interval = setInterval(heartbeat, 30_000);
  const stop = () => {
    clearInterval(interval);
    logger.info({ event: 'worker_stopped' }, '后台进程已停止');
    logger.flush();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  console.error(
    error instanceof ConfigurationError ? error.message : '后台进程启动失败，请检查配置。',
  );
  process.exitCode = 1;
}
