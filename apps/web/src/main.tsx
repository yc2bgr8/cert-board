import './schema-runtime.js';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LiveApp } from './LiveApp.js';
import { SessionProvider } from './live/useSession.js';
import './tailwind.css';

const root = document.getElementById('root');
if (!root) throw new Error('页面加载失败，请刷新重试。');
const queryClient = new QueryClient();
const showPrototype = new URLSearchParams(window.location.search).get('prototype') === '1';
const PrototypeApp = React.lazy(async () => ({
  default: (await import('./PrototypeApp.js')).PrototypeApp,
}));
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {showPrototype ? (
        <React.Suspense fallback={null}>
          <PrototypeApp />
        </React.Suspense>
      ) : (
        <SessionProvider>
          <LiveApp />
        </SessionProvider>
      )}
    </QueryClientProvider>
  </React.StrictMode>,
);
