import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import path from 'node:path';

const runtimeBoundaryPlugin = {
  rules: {
    'registry-factory-only': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          direct:
            '真实工具运行必须使用createToolRuntime领取执行权，不能直接导入无guard的ToolRegistry。',
          fixture: '生产后端不能加载测试夹具作为运行入口；真实运行必须经过执行权工厂。',
        },
      },
      create(context) {
        const check = (node) => {
          const source = node.source?.value;
          if (typeof source !== 'string') return;
          const resolved = path
            .resolve(path.dirname(context.filename), source)
            .replaceAll('\\', '/');
          const fixture = /(?:^|\/)test-support(?:[./]|$)/.test(source.replaceAll('\\', '/'));
          if (
            !fixture &&
            !/(?:^|\/)tools\/registry(?:\.[cm]?[jt]s)?$/.test(source) &&
            !/\/apps\/backend\/src\/tools\/registry(?:\.[cm]?[jt]s)?$/.test(resolved)
          )
            return;
          if (node.importKind === 'type' || node.exportKind === 'type') return;
          if (
            node.type === 'ImportDeclaration' &&
            node.specifiers.length &&
            node.specifiers.every((specifier) => specifier.importKind === 'type')
          )
            return;
          context.report({ node, messageId: fixture ? 'fixture' : 'direct' });
        };
        return {
          ImportDeclaration: check,
          ExportNamedDeclaration: check,
          ExportAllDeclaration: check,
        };
      },
    },
  },
};

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'coverage/**',
      'docs/**',
      'fixtures/**',
      '.local/**',
    ],
  },
  { ...js.configs.recommended, files: ['**/*.{js,mjs,ts,tsx}'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,ts,tsx}'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        structuredClone: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: [
      'apps/backend/src/{agent,tools,core,scheduler,outbound}/**/*.ts',
      'apps/backend/src/worker.ts',
    ],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: '模型请求只能经模型网关，工具不能直接联网。' },
        { name: 'WebSocket', message: '后台工具不能直接建立网络通道。' },
        { name: 'EventSource', message: '后台工具不能直接建立网络通道。' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message: '后台依赖必须静态声明，不能动态加载审批入口或来自数据的代码。',
        },
        {
          selector:
            'MemberExpression[property.name=/^(fetch|WebSocket|EventSource|getBuiltinModule)$/]',
          message: '不能通过全局对象或动态内建模块绕过网关与后台隔离。',
        },
        {
          selector:
            'MemberExpression[computed=true][property.value=/^(fetch|WebSocket|EventSource|getBuiltinModule)$/]',
          message: '不能通过计算属性绕过网关与后台隔离。',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/api/proposal-routes*',
                '**/api/review-routes*',
                '**/api/approval-routes*',
                '**/auth/session*',
              ],
              message: '审批与浏览器会话只供接口层使用，不能给Agent或后台提供审批调用路径。',
            },
            {
              group: ['node:child_process', 'child_process', 'node:vm', 'vm'],
              message: '后台不能执行Agent代码；代码执行必须通过隔离沙箱。',
            },
            {
              group: [
                'undici',
                'node:http',
                'http',
                'node:https',
                'https',
                'node:net',
                'net',
                'node:tls',
                'tls',
                'node:module',
                'module',
                'openai',
                '@anthropic-ai/*',
                '@google/genai',
                '@aws-sdk/*',
              ],
              message: '网络与模型SDK只能由固定边界模块使用；Agent和工具须调用模型网关或受控服务。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/backend/src/**/*.ts'],
    ignores: [
      '**/*.test.ts',
      '**/test-support.ts',
      '**/test-support/**',
      'apps/backend/src/agent/tool-runtime.ts',
    ],
    plugins: { 'cert-runtime': runtimeBoundaryPlugin },
    rules: { 'cert-runtime/registry-factory-only': 'error' },
  },
];
