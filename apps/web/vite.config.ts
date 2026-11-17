import { defineConfig } from 'vite';
import { randomBytes } from 'node:crypto';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const basePolicy =
  "default-src 'self'; script-src 'self'; img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const developmentNonce = randomBytes(18).toString('base64');
export default defineConfig({
  plugins: [react(), tailwindcss()],
  html: { cspNonce: developmentNonce },
  server: {
    host: '127.0.0.1',
    port: 28080,
    strictPort: true,
    headers: {
      'Content-Security-Policy': `${basePolicy.replace("script-src 'self'", `script-src 'self' 'nonce-${developmentNonce}'`)}; style-src 'self' 'nonce-${developmentNonce}'; connect-src 'self' ws://127.0.0.1:28080`,
    },
    proxy: { '/api': 'http://127.0.0.1:28081' },
  },
  preview: {
    host: '127.0.0.1',
    port: 28080,
    strictPort: true,
    headers: { 'Content-Security-Policy': `${basePolicy}; style-src 'self'; connect-src 'self'` },
  },
});
