import { z } from 'zod';

// 浏览器使用严格 CSP。加载共享模式前关闭 Zod 的动态代码生成。
z.config({ jitless: true });
