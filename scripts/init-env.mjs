import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export function initializeEnvironment(filename) {
  let text = existsSync(filename)
    ? readFileSync(filename, 'utf8')
    : '# 本地配置，不提交、不输出。\n';
  const values = parseEnv(text);
  const set = (key, value) => {
    if (values[key]) return;
    values[key] = value;
    text += `\n${key}=${value}`;
  };
  set('POSTGRES_PASSWORD', randomBytes(24).toString('hex'));
  set('MINIO_ROOT_USER', 'certboard');
  set('MINIO_ROOT_PASSWORD', randomBytes(24).toString('hex'));
  for (const account of ['ZHANGSAN', 'WANGMIN', 'ADMIN']) {
    set(`DEV_${account}_PASSWORD`, randomBytes(24).toString('hex'));
  }
  const prefix = `postgresql://cert_board:${encodeURIComponent(values.POSTGRES_PASSWORD)}@127.0.0.1:25432/`;
  set('DATABASE_URL', `${prefix}cert_board`);
  set('TEST_DATABASE_URL', `${prefix}cert_board_test`);
  for (const [key, value] of Object.entries({
    MINIO_ENDPOINT: '127.0.0.1',
    MINIO_PORT: '29000',
    MINIO_USE_SSL: 'false',
    MINIO_BUCKET: 'cert-board',
    HOST: '127.0.0.1',
    PORT: '28081',
    WEB_ORIGIN: 'http://127.0.0.1:28080',
    SESSION_TTL_HOURS: '12',
    NODE_ENV: 'development',
    LOG_LEVEL: 'info',
    HTTPS_PROXY: 'http://127.0.0.1:28085',
  }))
    set(key, value);
  writeFileSync(filename, `${text.trimEnd()}\n`, { mode: 0o600 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  initializeEnvironment(path.resolve('.env.local'));
  console.log('本地依赖配置已就绪，已有值保持不变，秘密不输出。');
}
