import { expect, test } from 'vitest';
import { agentEvaluationArguments, agentEvaluationEnvironment } from './eval-agent.mjs';

test('无密钥评测只使用系统环境，不继承模型、数据库或遥测配置', () => {
  expect(
    agentEvaluationEnvironment({
      Path: 'fixture-path',
      SYSTEMROOT: 'fixture-root',
      OPENROUTER_API_KEY: 'synthetic',
      DATABASE_URL: 'synthetic',
      NODE_OPTIONS: '--inspect',
      GOOGLE_SDK_NODE_LOGGING: '*',
      NODE_ENV: 'production',
    }),
  ).toEqual({
    Path: 'fixture-path',
    SYSTEMROOT: 'fixture-root',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
  });
});
test('评测固定执行真实Pi内核的剧本套件与依赖隔离检查，不运行占位脚本', () => {
  const args = agentEvaluationArguments();
  expect(args.slice(1)).toEqual([
    'run',
    'apps/backend/src/agent/pi/kernel.test.ts',
    'apps/backend/src/agent/pi/dependencies.test.ts',
  ]);
  expect(args.join(' ')).not.toContain('placeholder');
});
