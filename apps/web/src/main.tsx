import './schema-runtime.js';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PrototypeApp } from './PrototypeApp.js';
import { LiveApp } from './LiveApp.js';
import { SessionProvider } from './live/useSession.js';
import './tailwind.css';

const root = document.getElementById('root');
if (!root) throw new Error('页面加载失败，请刷新重试。');
const queryClient = new QueryClient();
const showPrototype = new URLSearchParams(window.location.search).get('prototype') === '1';
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {showPrototype ? (
        <PrototypeApp />
      ) : (
        <SessionProvider>
          <LiveApp />
        </SessionProvider>
      )}
    </QueryClientProvider>
  </React.StrictMode>,
);
