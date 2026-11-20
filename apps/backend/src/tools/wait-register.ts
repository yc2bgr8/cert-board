import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { goalWaitInputSchema, goalWaitResultSchema } from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import type { ToolDefinition } from './registry.js';

const undoState = z.object({ goalId: z.string().uuid() }).strict();
const missing = () =>
  new AppError(409, 'GOAL_WAIT_CONFLICT', '目标已有等待或状态已变化，请核对当前目标后再登记。');

export function waitRegisterTool(): ToolDefinition {
  return {
    metadata: {
      name: 'wait_register',
      version: 'builtin-goal-wait-v1',
      publication: 'published',
      effect: 'reversible_write',
      modes: ['ask', 'full'],
      approvalInAsk: false,
      outputDataLevel: 'internal',
      authorizationAction: 'project.write',
      description: {
        purpose: '登记当前目标等待的事件并结束本轮。事件到达后由后端唤醒。',
        whenToUse: '需要等待资料、定时或人工确认事件，已经记录现有结果时。',
        avoid:
          '人需要马上回答的问题用 ask_user。外部核实用 consult_external_model。等待不能代替批准。',
        parameters:
          'source 取 document、timer 或 manual。sourceKey 是具体来源编号。资料使用资料版本定位，定时需传带时区的 dueAt。reason 说明待完成工作。',
        example: {
          source: 'manual',
          sourceKey: 'example-review-2026',
          reason: '等待工作人员确认合成清单。',
        },
      },
    },
    inputSchema: goalWaitInputSchema,
    outputSchema: goalWaitResultSchema,
    async execute(ctx, raw, before) {
      if (!ctx.goalId || !before || before.targetType !== 'goal_wait') throw missing();
      const input = goalWaitInputSchema.parse(raw);
      const result = await ctx.tx.query(
        `INSERT INTO goal_wait(id,goal_id,run_id,source,source_key,reason,due_at)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [
          before.targetId,
          ctx.goalId,
          ctx.runId,
          input.source,
          input.sourceKey,
          input.reason,
          input.dueAt ?? null,
        ],
      );
      if (!result.rowCount) throw missing();
      const changed = await ctx.tx.query<{ version: number }>(
        'UPDATE goal SET version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING version',
        [ctx.goalId],
      );
      return {
        data: {
          waitId: before.targetId,
          goalId: ctx.goalId,
          source: input.source,
          sourceKey: input.sourceKey,
        },
        dataLevel: ctx.maxDataLevel,
        afterVersion: changed.rows[0]!.version,
      };
    },
    undo: {
      beforeSchema: undoState,
      async capture(ctx) {
        if (!ctx.goalId) throw missing();
        const state = (
          await ctx.tx.query<{ version: number }>(
            'SELECT version FROM goal WHERE id=$1 FOR UPDATE',
            [ctx.goalId],
          )
        ).rows[0];
        if (!state) throw missing();
        return {
          targetType: 'goal_wait',
          targetId: randomUUID(),
          beforeState: { goalId: ctx.goalId },
          beforeVersion: state.version,
        };
      },
      async currentVersion(ctx, record) {
        const { goalId } = undoState.parse(record.beforeState);
        if (ctx.goalId !== goalId) throw missing();
        return (
          (
            await ctx.tx.query<{ version: number }>(
              'SELECT version FROM goal WHERE id=$1 FOR UPDATE',
              [goalId],
            )
          ).rows[0]?.version ?? null
        );
      },
      async apply(ctx, record) {
        const { goalId } = undoState.parse(record.beforeState);
        if (ctx.goalId !== goalId) throw missing();
        const changed = await ctx.tx.query(
          `UPDATE goal_wait SET cancelled_at=clock_timestamp()
          WHERE id=$1 AND goal_id=$2 AND cancelled_at IS NULL AND responded_at IS NULL`,
          [record.targetId, goalId],
        );
        if (!changed.rowCount) throw missing();
        const restored = await ctx.tx.query<{ version: number }>(
          'UPDATE goal SET version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING version',
          [goalId],
        );
        return { afterVersion: restored.rows[0]!.version };
      },
    },
  };
}
