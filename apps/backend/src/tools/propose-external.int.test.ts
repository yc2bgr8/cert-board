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

test.each(['ask', 'full'] as const)(
  '%s真实登记工具始终返回待提案且回放一致，不建立外发队列',
  async (permissionMode) => {
    const contact = await fixture.pool.query<{ id: string }>(
      "INSERT INTO contact(project_id,name,address,source) VALUES($1,'虚构测试联系人',$2,'集成测试') RETURNING id",
      [fixture.projectId, `local-test-recipient-${permissionMode}`],
    );
    const { conversationId, ...run } = await fixture.run('MEMBER_A', permissionMode);
    const registry = new ToolRegistry(fixture.pool, [proposeExternalTool()], {
      environment: 'test',
    });
    const input = {
      contactId: contact.rows[0]!.id,
      subject: '测试提案',
      body: '仅本地记录，不向外发送。',
    };
    const first = await registry.execute(run, 'propose_external', input);
    expect(first.status).toBe('pending_proposal');
    expect(first.data).toMatchObject({ status: 'proposed', channel: 'local_test', sent: false });
    expect(await registry.execute(run, 'propose_external', input)).toMatchObject({
      invocationId: first.invocationId,
      status: 'pending_proposal',
      replayed: true,
    });
    const rows = await fixture.pool.query(
      `SELECT (SELECT count(*)::int FROM proposal WHERE conversation_id=$1) AS proposals,
     (SELECT count(*)::int FROM decision d JOIN proposal p ON p.id=d.proposal_id WHERE p.conversation_id=$1) AS decisions,
     (SELECT count(*)::int FROM outbound_message o JOIN proposal p ON p.id=o.proposal_id WHERE p.conversation_id=$1) AS queues`,
      [conversationId],
    );
    expect(rows.rows).toEqual([{ proposals: 1, decisions: 0, queues: 0 }]);
  },
);

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
