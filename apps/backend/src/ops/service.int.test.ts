import { expect, test } from 'vitest';
import { opsAlertResponseSchema } from '@cert-board/shared';
import { createIntegrationContext } from '../test-support/context.js';
import { saveOpsFindings, scanOpsAlerts } from './service.js';

test('本机检查汇总服务、心跳、唤醒和备份，恢复时更新且仅管理账号可读', async () => {
  const c = await createIntegrationContext();
  try {
    const run = await c.run('MEMBER_A');
    await c.pool.query(
      `INSERT INTO run(conversation_id,user_id,project_id,goal_id,trigger_type,status)
       VALUES($1,$2,$3,$4,'wakeup','failed')`,
      [run.conversationId, run.userId, c.projectId, c.goalId],
    );
    await c.pool.query(
      `INSERT INTO audit_log(actor_kind,action,target_type,target_id)
        VALUES('system','backup.failed','backup','synthetic-ops')`,
    );
    const { CERT_DOCSVC_URL: _docsvc, CERT_SANDBOX_URL: _sandbox, ...config } = c.config;
    const health = {
      checkDatabase: async () => undefined,
      checkStorage: async () => {
        throw new Error('synthetic-storage-down');
      },
      close: async () => undefined,
    };
    const asOf = new Date(Date.now() + 1000);
    const first = await scanOpsAlerts(c.pool, config, health, false, asOf);
    expect(first.map(({ key }) => key)).toEqual(
      expect.arrayContaining([
        'service_storage',
        'deadline_stale',
        'wake_failures',
        'backup_failed',
      ]),
    );
    expect(await scanOpsAlerts(c.pool, config, health, false, asOf)).toEqual([]);

    const admin = await c.login('ADMIN');
    const member = await c.login('MEMBER_A');
    const url = '/api/ops/alerts';
    expect((await c.app.inject({ url, headers: member.headers })).statusCode).toBe(403);
    expect((await c.app.inject({ url })).statusCode).toBe(403);
    const response = await c.app.inject({ url, headers: admin.headers });
    expect(response.statusCode).toBe(200);
    const summary = opsAlertResponseSchema.parse(response.json());
    expect(summary.checkedAt).toBe(asOf.toISOString());
    expect(summary.stale).toBe(false);
    expect(summary.alerts.find(({ key }) => key === 'service_storage')).toMatchObject({
      level: 'critical',
      openedAt: asOf.toISOString(),
      lastSeenAt: asOf.toISOString(),
    });
    expect(response.body).not.toContain('synthetic-storage-down');
    const next = new Date(asOf.getTime() + 1000);
    await saveOpsFindings(
      c.pool,
      [
        {
          key: 'service_storage',
          level: 'critical',
          detail: '文件存储检测结果未知。',
          active: null,
        },
      ],
      next,
    );
    expect(
      opsAlertResponseSchema
        .parse((await c.app.inject({ url, headers: admin.headers })).json())
        .alerts.some(({ key }) => key === 'service_storage'),
    ).toBe(true);
    await saveOpsFindings(
      c.pool,
      [
        {
          key: 'service_storage',
          level: 'critical',
          detail: '文件存储已恢复。',
          active: false,
        },
      ],
      new Date(next.getTime() + 1000),
    );
    expect(
      opsAlertResponseSchema
        .parse((await c.app.inject({ url, headers: admin.headers })).json())
        .alerts.some(({ key }) => key === 'service_storage'),
    ).toBe(false);
  } finally {
    await c.close();
  }
});
