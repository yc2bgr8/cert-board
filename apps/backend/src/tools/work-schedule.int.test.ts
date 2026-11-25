import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { createIntegrationContext } from '../test-support/context.js';
import { workScheduleTool } from './work-schedule.js';
import { ToolRegistry } from './registry.js';

test('注册项目的只读对话可计算计划，不产生撤销记录或项目写入', async () => {
  const context = await createIntegrationContext();
  try {
    const run = await context.run('MEMBER_A', 'read_only');
    const registry = new ToolRegistry(context.pool, [workScheduleTool()], { environment: 'test' });
    const ref = { runId: run.runId, userId: run.userId, callId: randomUUID() };
    const name = 'work_schedule_calculate';
    const nodes = [
      { id: 'review', name: '合成报告审核', owner: '合成负责人', durationDays: 2, dependsOn: [] },
    ];
    const result = await registry.execute(ref, name, { targetDate: '2031-01-08', nodes });
    expect(result).toMatchObject({
      undoId: null,
      data: {
        latestStartDate: '2031-01-06',
        feasibility: 'start_unconfirmed',
        criticalPath: ['review'],
      },
    });
    const records = await context.pool.query<{ effect: string }>(
      'SELECT effect FROM tool_invocation WHERE id=$1',
      [result.invocationId],
    );
    expect(records.rows).toEqual([{ effect: 'read' }]);
    await expect(
      registry.execute({ ...ref, callId: randomUUID() }, name, {
        targetDate: '2031-01-08',
        nodes: [{ ...nodes[0]!, dependsOn: ['review'] }],
      }),
    ).rejects.toMatchObject({
      code: 'TOOL_DATA_REJECTED',
      message: expect.stringContaining('前置关系形成环'),
    });
  } finally {
    await context.close();
  }
});
