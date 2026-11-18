import { spawnSync } from 'node:child_process';
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
export function agentEvaluationArguments() {
  return [
    path.join(root, 'node_modules/vitest/vitest.mjs'),
    'run',
    'apps/backend/src/agent/pi/kernel.test.ts',
    'apps/backend/src/agent/pi/dependencies.test.ts',
  ];
}
export function runAgentEvaluation() {
  console.log(
    '运行同一 Pi 1.3 内核的剧本回归：多轮工具、审核与提案暂停、取消、预算、历史和错误脱敏；无需模型密钥。',
  );
  const result = spawnSync(process.execPath, agentEvaluationArguments(), {
    cwd: root,
    env: agentEvaluationEnvironment(),
    stdio: 'inherit',
  });
  if (result.error) console.error('Agent剧本评测未能启动，请先安装仓库依赖。');
  return result.status ?? 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runAgentEvaluation();
}
