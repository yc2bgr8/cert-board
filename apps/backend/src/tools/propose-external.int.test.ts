import { afterAll, beforeAll, expect, test } from 'vitest';
import { ToolRegistry } from './registry.js';
import { proposeExternalTool } from './propose-external.js';
import { createIntegrationContext } from '../test-support/context.js';

let fixture: Awaited<ReturnType<typeof createIntegrationContext>>;
beforeAll(async () => {
  fixture = await createIntegrationContext();
});
afterAll(async () => {
  if (fixture) await fixture.close();
});

test('真实登记工具仅建同项目本地测试提案，幂等不重复、不建立执行回执', async () => {
  const contact = await fixture.pool.query<{ id: string }>(
    "INSERT INTO contact(project_id,name,address,source) VALUES($1,'虚构测试联系人','local-test-recipient','集成测试') RETURNING id",
    [fixture.projectId],
  );
  const { conversationId: _conversation, ...run } = await fixture.run();
  const registry = new ToolRegistry(fixture.pool, [proposeExternalTool()], { environment: 'test' });
  const input = {
    contactId: contact.rows[0]!.id,
    subject: '测试提案',
    body: '仅本地记录，不向外发送。',
  };
  const first = await registry.execute(run, 'propose_external', input);
  expect(first.data).toMatchObject({ status: 'proposed', channel: 'local_test', sent: false });
  expect((await registry.execute(run, 'propose_external', input)).replayed).toBe(true);
  const rows = await fixture.pool.query(
    'SELECT (SELECT count(*)::int FROM proposal) AS proposals,(SELECT count(*)::int FROM decision) AS decisions,(SELECT count(*)::int FROM outbound_message) AS queues',
  );
  expect(rows.rows).toEqual([{ proposals: 1, decisions: 0, queues: 0 }]);
});

test('不登记的联系人或附件字段不能进入外发提案', async () => {
  const { conversationId: _conversation, ...run } = await fixture.run();
  const registry = new ToolRegistry(fixture.pool, [proposeExternalTool()], { environment: 'test' });
  await expect(
    registry.execute(run, 'propose_external', {
      contactId: '00000000-0000-4000-8000-000000000001',
      subject: '测试',
      body: '正文',
    }),
  ).rejects.toMatchObject({ statusCode: 400 });
  await expect(
    registry.execute({ ...run, callId: 'attachments' }, 'propose_external', {
      contactId: '00000000-0000-4000-8000-000000000001',
      subject: '测试',
      body: '正文',
      attachments: ['private-file'],
    }),
  ).rejects.toMatchObject({ statusCode: 400 });
});
