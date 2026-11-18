import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { z } from 'zod';
import type { Notification } from 'pg';
import { runControlNotificationSchema } from '@cert-board/shared';
import { createIntegrationContext } from '../test-support/context.js';
import { createToolRuntime } from './tool-runtime.js';
import { registerRunControlRoutes } from '../api/run-control-routes.js';
import { RUN_CONTROL_CHANNEL } from '../runs/control.js';
import type { ToolDefinition, ToolExecutionContext } from '../tools/registry.js';

let context: Awaited<ReturnType<typeof createIntegrationContext>>;
beforeEach(async () => {
  context = await createIntegrationContext();
  if (!context.app.hasRoute({ method: 'POST', url: '/api/runs/:id/stop' }))
    registerRunControlRoutes(context.app, context.pool, context.config);
});
afterEach(async () => {
  await context?.close();
});

const callReference = (source: { runId: string; userId: string; callId: string }) => ({
  runId: source.runId,
  userId: source.userId,
  callId: source.callId,
});

function readTool(
  onRead: (ctx: ToolExecutionContext) => Promise<void> = async () => undefined,
): ToolDefinition {
  return {
    metadata: {
      name: 'runtime_read',
      version: '1',
      publication: 'published',
      effect: 'read',
      roles: ['RA'],
      modes: ['execute', 'read_only'],
      outputDataLevel: 'internal',
      authorizationAction: 'project.read',
      description: {
        purpose: '读取测试回执。',
        whenToUse: '仅测试。',
        avoid: '不能修改业务。',
        parameters: '无参数。',
        example: {},
      },
    },
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ ok: z.literal(true) }).strict(),
    async execute(ctx) {
      await onRead(ctx);
      return { data: { ok: true }, dataLevel: 'internal' };
    },
  };
}
async function runtime(
  definitions: ToolDefinition[],
  run?: Awaited<ReturnType<typeof context.run>>,
  controller = new AbortController(),
) {
  const source = run ?? (await context.run());
  const created = await createToolRuntime({
    pool: context.pool,
    definitions,
    ...source,
    ownerId: randomUUID(),
    signal: controller.signal,
    environment: 'test',
  });
  return { ...created, source, controller };
}

test('唯一工厂真实claim，租约绑定不可变，拒绝跨run及失权缓存重放', async () => {
  let executions = 0;
  const created = await runtime([
    readTool(async () => {
      executions++;
    }),
  ]);
  expect(created.lease.generation).toBe(1);
  expect(Object.isFrozen(created.lease)).toBe(true);
  const result = await created.registry.execute(callReference(created.source), 'runtime_read', {});
  expect(result.replayed).toBe(false);
  expect(
    (await created.registry.execute(callReference(created.source), 'runtime_read', {})).replayed,
  ).toBe(true);
  expect(executions).toBe(1);
  const another = await context.run();
  await expect(
    created.registry.execute(callReference(another), 'runtime_read', {}),
  ).rejects.toMatchObject({
    code: 'TOOL_RUNTIME_INACTIVE',
  });
  await context.pool.query(
    "UPDATE run SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
    [created.source.runId],
  );
  const replacement = await runtime([readTool()], created.source);
  expect(replacement.lease.generation).toBe(2);
  await expect(
    created.registry.execute(callReference(created.source), 'runtime_read', {}),
  ).rejects.toMatchObject({
    code: 'TOOL_RUNTIME_INACTIVE',
  });
  expect(executions).toBe(1);
});

test('handler执行期间执行权到期，提交前检查回滚全部调用记录', async () => {
  const created = await runtime([
    readTool(async (ctx) => {
      await ctx.tx.query(
        "UPDATE run SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
        [ctx.runId],
      );
    }),
  ]);
  await expect(
    created.registry.execute(callReference(created.source), 'runtime_read', {}),
  ).rejects.toMatchObject({
    code: 'TOOL_RUNTIME_INACTIVE',
  });
  expect(
    (
      await context.pool.query(
        'SELECT COUNT(*)::int AS count FROM tool_invocation WHERE run_id=$1',
        [created.source.runId],
      )
    ).rows[0].count,
  ).toBe(0);
});

test('停止接口真实认证且只控制自己的run，重复停止不重复审计', async () => {
  const run = await context.run();
  const auth = await context.login();
  const other = await context.login('RB');
  for (const headers of [
    { 'sec-fetch-site': 'same-origin' },
    { cookie: auth.cookie, origin: context.config.WEB_ORIGIN, 'sec-fetch-site': 'same-origin' },
    { ...auth.headers, origin: 'https://untrusted.invalid' },
    other.headers,
  ]) {
    const denied = await context.app.inject({
      method: 'POST',
      url: `/api/runs/${run.runId}/stop`,
      headers,
      payload: {},
    });
    expect([401, 403, 404].includes(denied.statusCode)).toBe(true);
  }
  const first = await context.app.inject({
    method: 'POST',
    url: `/api/runs/${run.runId}/stop`,
    headers: auth.headers,
    payload: {},
  });
  expect(first.statusCode).toBe(200);
  expect(first.json()).toEqual({ runId: run.runId, status: 'stopped', changed: true });
  const second = await context.app.inject({
    method: 'POST',
    url: `/api/runs/${run.runId}/stop`,
    headers: auth.headers,
    payload: {},
  });
  expect(second.json().changed).toBe(false);
  expect(
    (
      await context.pool.query(
        "SELECT COUNT(*)::int AS count FROM audit_log WHERE action='run.stop_requested' AND target_id=$1",
        [run.runId],
      )
    ).rows[0].count,
  ).toBe(1);
});

test('工具持写锁时停止通知仍在1秒内到达，abort使业务与undo在提交前回滚', async () => {
  const listener = await context.pool.connect();
  const controller = new AbortController();
  let started!: () => void;
  const handlerStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let abortedAt: number | undefined;
  const beforeSchema = z.object({ nextAction: z.string().nullable() }).strict();
  const writer: ToolDefinition = {
    ...readTool(),
    metadata: {
      ...readTool().metadata,
      name: 'runtime_write',
      effect: 'reversible_write',
      authorizationAction: 'project.write',
      modes: ['execute'],
    },
    async execute(ctx, _input, before) {
      await ctx.tx.query(
        "UPDATE cert_project SET next_action='待回滚测试内容',version=version+1 WHERE id=$1",
        [ctx.projectId],
      );
      started();
      await new Promise<void>((resolve) => {
        const abort = () => {
          abortedAt = Date.now();
          resolve();
        };
        if (ctx.signal?.aborted) abort();
        else ctx.signal?.addEventListener('abort', abort, { once: true });
      });
      return {
        data: { ok: true },
        dataLevel: 'internal',
        afterVersion: Number(before!.beforeVersion) + 1,
      };
    },
    undo: {
      beforeSchema,
      async capture(ctx) {
        const result = await ctx.tx.query(
          'SELECT next_action,version FROM cert_project WHERE id=$1 FOR UPDATE',
          [ctx.projectId],
        );
        return {
          targetType: 'cert_project',
          targetId: ctx.projectId!,
          beforeState: { nextAction: result.rows[0].next_action },
          beforeVersion: result.rows[0].version,
        };
      },
      async currentVersion(ctx, record) {
        return (
          (await ctx.tx.query('SELECT version FROM cert_project WHERE id=$1', [record.targetId]))
            .rows[0]?.version ?? null
        );
      },
      async apply() {
        throw new Error('本测试不应进入撤销');
      },
    },
  };
  const created = await runtime([writer], undefined, controller);
  const original = (
    await context.pool.query('SELECT next_action,version FROM cert_project WHERE id=$1', [
      context.projectId,
    ])
  ).rows[0];
  const receive = (message: Notification) => {
    if (message.channel !== RUN_CONTROL_CHANNEL) return;
    let value: unknown;
    try {
      value = JSON.parse(message.payload ?? '');
    } catch {
      return;
    }
    const parsed = runControlNotificationSchema.safeParse(value);
    if (
      parsed.success &&
      parsed.data.runId === created.source.runId &&
      parsed.data.userId === created.source.userId
    )
      controller.abort();
  };
  listener.on('notification', receive);
  await listener.query(`LISTEN ${RUN_CONTROL_CHANNEL}`);
  const pending = created.registry.execute(callReference(created.source), 'runtime_write', {}).then(
    () => 'unexpected_success',
    (error: unknown) => (error as { code: string }).code,
  );
  let safetyTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      handlerStarted,
      pending.then(() => {
        throw new Error('工具在进入handler前退出，请核对前置条件。');
      }),
    ]);
    const auth = await context.login();
    const start = Date.now();
    safetyTimer = setTimeout(() => controller.abort(), 3000);
    const stopped = await context.app.inject({
      method: 'POST',
      url: `/api/runs/${created.source.runId}/stop`,
      headers: auth.headers,
      payload: {},
    });
    expect(stopped.statusCode).toBe(200);
    expect(abortedAt !== undefined && abortedAt - start < 1000).toBe(true);
    expect(await pending).toBe('TOOL_RUNTIME_INACTIVE');
    expect(
      (
        await context.pool.query('SELECT next_action,version FROM cert_project WHERE id=$1', [
          context.projectId,
        ])
      ).rows[0],
    ).toEqual(original);
    expect(
      (
        await context.pool.query('SELECT COUNT(*)::int AS count FROM undo_record WHERE run_id=$1', [
          created.source.runId,
        ])
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await context.pool.query('SELECT lease_owner,status FROM run WHERE id=$1', [
          created.source.runId,
        ])
      ).rows[0],
    ).toEqual({ lease_owner: null, status: 'stopped' });
  } finally {
    if (safetyTimer) clearTimeout(safetyTimer);
    controller.abort();
    await pending;
    listener.off('notification', receive);
    await listener.query(`UNLISTEN ${RUN_CONTROL_CHANNEL}`);
    listener.release();
  }
});
