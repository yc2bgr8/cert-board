import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PrototypeApp } from './PrototypeApp.js';
import './tailwind.css';

const root = document.getElementById('root');
if (!root) throw new Error('页面加载失败，请刷新重试。');
const queryClient = new QueryClient();
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <PrototypeApp />
    </QueryClientProvider>
  </React.StrictMode>,
);
