import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const systemKeys = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'HOME',
  'LANG',
]);
export function agentEvaluationEnvironment(inherited = process.env) {
  return {
    ...Object.fromEntries(
      Object.entries(inherited).filter(([key]) => systemKeys.has(key.toUpperCase())),
    ),
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
  };
}
export function agentEvaluationArguments(integration = false) {
  const suites = JSON.parse(readFileSync(path.join(root, 'evals/agent/suites.json'), 'utf8'));
  const files = integration ? suites.integration : suites.headless;
  const valid = /^apps\/backend\/src\/(?:[a-z0-9-]+\/)*[a-z0-9-]+(?:\.int)?\.test\.ts$/u;
  if (
    !Array.isArray(files) ||
    files.length === 0 ||
    new Set(files).size !== files.length ||
    files.some(
      (file) =>
        typeof file !== 'string' ||
        !valid.test(file) ||
        file.endsWith('.int.test.ts') !== integration ||
        !existsSync(path.join(root, file)),
    )
  )
    throw new Error('评测清单包含无效或重复的测试路径。');
  return integration
    ? [path.join(root, 'scripts/test-integration.mjs'), ...files]
    : [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...files];
}
export function runAgentEvaluation(integration = false) {
  let args;
  try {
    args = agentEvaluationArguments(integration);
  } catch {
    console.error('Agent 评测清单无效，请核对 evals/agent/suites.json。');
    return 1;
  }
  console.log(
    integration
      ? '运行 Agent 剧本与本地测试库的工作区、插话、暂停、子任务和唤醒场景。'
      : '运行同一 Pi 内核的无界面剧本和合成业务场景，无需模型密钥或测试数据库。',
  );
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: agentEvaluationEnvironment(),
    stdio: 'inherit',
  });
  if (result.error) console.error('Agent剧本评测未能启动，请先安装仓库依赖。');
  return result.status ?? 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === '--integration'))
    process.exitCode = runAgentEvaluation(args.length === 1);
  else {
    console.error('使用 pnpm eval:agent，或 pnpm eval:agent --integration。');
    process.exitCode = 2;
  }
}
