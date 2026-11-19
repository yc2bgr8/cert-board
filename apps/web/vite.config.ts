import { defineConfig } from 'vite';
import { randomBytes } from 'node:crypto';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {
  browserContentSecurityPolicy,
  browserReferrerPolicy,
} from '../../packages/shared/src/browser-csp.js';

const developmentNonce = randomBytes(18).toString('base64');
export default defineConfig({
  plugins: [react(), tailwindcss()],
  html: { cspNonce: developmentNonce },
  server: {
    host: '127.0.0.1',
    port: 28080,
    strictPort: true,
    headers: {
      'Referrer-Policy': browserReferrerPolicy,
      'Content-Security-Policy': browserContentSecurityPolicy
        .replace("script-src 'self'", `script-src 'self' 'nonce-${developmentNonce}'`)
        .replace("connect-src 'self'", "connect-src 'self' ws://127.0.0.1:28080"),
    },
    proxy: { '/api': 'http://127.0.0.1:28081' },
  },
  preview: {
    host: '127.0.0.1',
    port: 28080,
    strictPort: true,
    headers: {
      'Content-Security-Policy': browserContentSecurityPolicy,
      'Referrer-Policy': browserReferrerPolicy,
    },
  },
});
