import js from '@eslint/js';
import tseslint from 'typescript-eslint';

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
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message: '后台依赖必须静态声明，不能动态加载审批入口或来自数据的代码。',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/api/proposal-routes*', '**/api/review-routes*', '**/auth/session*'],
              message: '审批与浏览器会话只供接口层使用，不能给Agent或后台提供审批调用路径。',
            },
            {
              group: ['node:child_process', 'child_process', 'node:vm', 'vm'],
              message: '后台不能执行Agent代码；代码执行必须通过隔离沙箱。',
            },
          ],
        },
      ],
    },
  },
];
