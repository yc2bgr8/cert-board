import path from 'node:path';
import { ESLint } from 'eslint';
import { expect, test } from 'vitest';

test('Agent与后台代码不能导入审批入口、浏览器会话或宿主机执行器', async () => {
  const lint = new ESLint();
  for (const spec of [
    '../api/proposal-routes.js',
    '../api/review-routes.js',
    '../auth/session.js',
    'node:child_process',
    'node:vm',
  ]) {
    const results = await lint.lintText(`import '${spec}';`, {
      filePath: path.join(process.cwd(), 'apps/backend/src/tools/boundary-probe.ts'),
    });
    expect(
      results.some((result) =>
        result.messages.some((message) => message.ruleId === 'no-restricted-imports'),
      ),
    ).toBe(true);
  }
  const allowed = await lint.lintText("import '../api/errors.js';", {
    filePath: path.join(process.cwd(), 'apps/backend/src/tools/boundary-probe.ts'),
  });
  expect(allowed.every((result) => result.errorCount === 0)).toBe(true);
});

test('后台也不能通过动态模块加载绕过审批和宿主机执行隔离', async () => {
  const lint = new ESLint();
  for (const code of [
    "void import('../auth/session.js');",
    "void import('../api/proposal-routes.js');",
    "void import('node:child_process');",
    "const modulePath='./from-data.js'; void import(modulePath);",
  ]) {
    const results = await lint.lintText(code, {
      filePath: path.join(process.cwd(), 'apps/backend/src/tools/dynamic-boundary-probe.ts'),
    });
    expect(
      results.some((result) =>
        result.messages.some((message) => message.ruleId === 'no-restricted-syntax'),
      ),
    ).toBe(true);
  }
});

test('过程批准和对话写API不能由Agent、工具或worker导入', async () => {
  const lint = new ESLint();
  for (const source of [
    '../api/approval-routes.js',
    '../api/conversation-write-routes.js',
    '../conversations/commands.js',
  ]) {
    for (const file of ['agent/approval-probe.ts', 'tools/approval-probe.ts', 'worker.ts']) {
      const results = await lint.lintText(`import '${source}';`, {
        filePath: path.join(process.cwd(), 'apps/backend/src', file),
      });
      expect(
        results.some((result) =>
          result.messages.some((message) => message.ruleId === 'no-restricted-imports'),
        ),
      ).toBe(true);
    }
  }
});

test('Agent与工具不能绕过模型网关直接建立网络请求', async () => {
  const lint = new ESLint();
  for (const code of [
    "import 'undici';",
    "import 'node:http';",
    "import 'node:https';",
    "import 'node:net';",
    "import 'node:tls';",
    "import 'node:module';",
    "import 'openai';",
    "void fetch('https://example.invalid');",
    "void globalThis.fetch('https://example.invalid');",
    "void globalThis['fetch']('https://example.invalid');",
    "void process.getBuiltinModule('http');",
  ]) {
    const results = await lint.lintText(code, {
      filePath: path.join(process.cwd(), 'apps/backend/src/agent/network-probe.ts'),
    });
    expect(
      results.some((result) =>
        result.messages.some((message) =>
          ['no-restricted-imports', 'no-restricted-syntax', 'no-restricted-globals'].includes(
            message.ruleId,
          ),
        ),
      ),
    ).toBe(true);
  }
});

test('真实Agent和worker只能经执行权工厂构造Registry，别名与转导出同样拒绝', async () => {
  const lint = new ESLint();
  for (const [code, relative] of [
    [
      "import { ToolRegistry as Registry } from '../tools/registry.js'; void Registry;",
      'agent/unsafe.ts',
    ],
    ["export { ToolRegistry } from '../tools/registry.js';", 'agent/forward.ts'],
    ["export * from './tools/registry.js';", 'worker.ts'],
    [
      "import { createReviewTestContext } from '../reviews/test-support.js'; void createReviewTestContext;",
      'agent/fixture-bypass.ts',
    ],
  ]) {
    const results = await lint.lintText(code, {
      filePath: path.join(process.cwd(), 'apps/backend/src', relative),
    });
    expect(
      results.some((result) =>
        result.messages.some((message) => message.ruleId === 'cert-runtime/registry-factory-only'),
      ),
    ).toBe(true);
  }
  for (const relative of [
    'agent/tool-runtime.ts',
    'tools/library.test.ts',
    'reviews/test-support.ts',
  ]) {
    const results = await lint.lintText(
      "import { ToolRegistry } from '../tools/registry.js'; void ToolRegistry;",
      {
        filePath: path.join(process.cwd(), 'apps/backend/src', relative),
      },
    );
    expect(results.every((result) => result.errorCount === 0)).toBe(true);
  }
  const types = await lint.lintText(
    "import type { ToolDefinition } from '../tools/registry.js'; export type Definition = ToolDefinition;",
    {
      filePath: path.join(process.cwd(), 'apps/backend/src/agent/types.ts'),
    },
  );
  expect(types.every((result) => result.errorCount === 0)).toBe(true);
});
