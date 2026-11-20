import { defineConfig } from 'vite';
import base from './vite.config.js';

const port = Number(process.env.CERT_PREVIEW_API_PORT);
if (port !== 28281 && port !== 28381) throw new Error('预览代理只使用独立的回环 API 端口。');
const instance = process.env.CERT_PREVIEW_INSTANCE;
if (!instance || !/^[0-9a-f-]{36}$/u.test(instance)) throw new Error('缺少本次预览实例编号。');

export default defineConfig({
  ...base,
  preview: {
    ...base.preview,
    headers: { ...base.preview?.headers, 'x-cert-preview-instance': instance },
    proxy: { '/api': `http://127.0.0.1:${port}` },
  },
});
