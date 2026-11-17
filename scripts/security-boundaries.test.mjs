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
