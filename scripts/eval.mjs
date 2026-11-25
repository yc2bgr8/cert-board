import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentEvaluationEnvironment, runAgentEvaluation } from './eval-agent.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const suites = [
  'apps/backend/src/agent/evaluation/cert-line.test.ts',
  'apps/backend/src/agent/evaluation/cert-line-comparison.test.ts',
  'apps/backend/src/agent/evaluation/l08-e07.test.ts',
  'apps/backend/src/agent/evaluation/r09-extraction.test.ts',
  'apps/backend/src/agent/evaluation/r09-l08.test.ts',
  'apps/backend/src/checks/quantities.test.ts',
  'apps/backend/src/rules/rv05.test.ts',
];

const agent = runAgentEvaluation();
const cases = spawnSync(
  process.execPath,
  [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...suites],
  { cwd: root, env: agentEvaluationEnvironment(), stdio: 'inherit' },
);
if (cases.error) console.error('评测未能启动，请先安装仓库依赖。');
process.exitCode = agent || (cases.status ?? 1);
