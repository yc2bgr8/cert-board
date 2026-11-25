import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { createIntegrationContext } from '../test-support/context.js';
import { buildAgentTools } from '../agent/default-tools.js';
import { ToolRegistry } from './registry.js';

test('注册项目的只读对话可计算计划，不产生撤销记录或项目写入', async () => {
  const context = await createIntegrationContext();
  try {
    const run = await context.run('MEMBER_A', 'read_only');
    const maintenance = await context.run('MEMBER_A', 'read_only', 'maintenance');
    const storage = {
      get: vi.fn(async () => {
        throw new Error('不应读取文件');
      }),
      put: vi.fn(async () => {
        throw new Error('不应写入文件');
      }),
    };
    const registry = new ToolRegistry(
      context.pool,
      await buildAgentTools(storage, 'registration'),
      { environment: 'test' },
    );
    const maintenanceRegistry = new ToolRegistry(
      context.pool,
      await buildAgentTools(storage, 'maintenance'),
      { environment: 'test' },
    );
    const ref = { runId: run.runId, userId: run.userId, callId: randomUUID() };
    const name = 'work_schedule_calculate';
    const state = async () =>
      (
        await context.pool.query(
          `SELECT (SELECT to_jsonb(p) FROM cert_project p WHERE p.id=$1) AS project,
       (SELECT to_jsonb(g) FROM goal g WHERE g.id=$2) AS goal,
       (SELECT jsonb_agg(to_jsonb(w) ORDER BY w.id) FROM workspace w WHERE w.project_id=$1) AS workspace,
       (SELECT count(*) FROM workspace_draft wd WHERE wd.conversation_id=$3) AS drafts`,
          [context.projectId, context.goalId, run.conversationId],
        )
      ).rows[0];
    const before = await state();
    expect(await registry.catalog({ runId: run.runId, userId: run.userId })).toContainEqual(
      expect.objectContaining({ name, effect: 'read' }),
    );
    expect(
      (
        await maintenanceRegistry.catalog({ runId: maintenance.runId, userId: maintenance.userId })
      ).some((entry) => entry.name === name),
    ).toBe(false);
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
    expect(await state()).toEqual(before);
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
  } finally {
    await context.close();
  }
});
