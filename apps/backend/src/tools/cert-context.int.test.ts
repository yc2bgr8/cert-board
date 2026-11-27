import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { buildAgentTools } from '../agent/default-tools.js';
import { executeAgentRun } from '../agent/runtime.js';
import { seedDevelopmentBudgetPolicy } from '../budget/service.js';
import { ModelGateway, type GatewayTransport } from '../modelgw/service.js';
import { parseSkillDraftMarkdown } from '../skills/markdown.js';
import { stageSkillVersion } from '../skills/service.js';
import { browserModels } from '../test-support/browser-fixture.js';
import { createIntegrationContext } from '../test-support/context.js';
import { ToolRegistry } from './registry.js';

function memoryStore() {
  const files = new Map<string, Buffer>();
  return {
    async put(data: Buffer) {
      const sha256 = createHash('sha256').update(data).digest('hex');
      files.set(sha256, Buffer.from(data));
      return { sha256, byteSize: data.length };
    },
    async get(hash: string) {
      const data = files.get(hash);
      if (!data) throw Error('缺少合成对象');
      return Buffer.from(data);
    },
  };
}

test('当前范围只读，另页只含本人负责事项，升密或更换负责人后历史回执重新校验', async () => {
  const context = await createIntegrationContext();
  try {
    const run = await context.run('MEMBER_A', 'read_only');
    const otherUser = context.userId('MEMBER_B');
    const ownedId = randomUUID();
    const otherId = randomUUID();
    await context.pool.query(
      `INSERT INTO cert_project(id,name,project_type,market,pathway,owner_user_id)
       VALUES($1,'本人的合成项目','registration','CA','待研判',$2),
             ($3,'另一成员的合成项目','registration','CA','待研判',$4)`,
      [ownedId, run.userId, otherId, otherUser],
    );
    await context.pool.query(
      `INSERT INTO goal(project_id,owner_user_id,title,acceptance_criteria)
       VALUES($1,$2,'本人的合成目标','只测试读取范围'),($3,$4,'别人的合成目标','只测试读取范围')`,
      [ownedId, run.userId, otherId, otherUser],
    );
    const registry = new ToolRegistry(
      context.pool,
      await buildAgentTools(memoryStore(), 'registration'),
      { environment: 'test' },
    );
    const ref = { runId: run.runId, userId: run.userId, callId: randomUUID() };
    const tool = 'cert_context';
    expect(await registry.catalog({ runId: run.runId, userId: run.userId })).toContainEqual(
      expect.objectContaining({ name: tool, effect: 'read' }),
    );
    const scoped = await registry.execute(ref, tool, {});
    expect(scoped).toMatchObject({
      undoId: null,
      dataLevel: 'internal',
      data: {
        user: { id: run.userId, isManagement: false },
        project: { id: context.projectId },
        goal: { id: context.goalId },
        owned: null,
      },
    });
    const listRef = { ...ref, callId: randomUUID() };
    const list = await registry.execute(listRef, tool, { scope: 'owned' });
    expect(list.data).toMatchObject({
      owned: {
        projects: expect.arrayContaining([expect.objectContaining({ id: ownedId })]),
        goals: expect.arrayContaining([
          expect.objectContaining({ projectId: ownedId, title: '本人的合成目标' }),
        ]),
      },
    });
    expect(JSON.stringify(list.data)).not.toContain(otherId);
    expect(JSON.stringify(list.data)).not.toContain('别人的合成目标');
    await context.pool.query(
      "INSERT INTO workspace(project_id,data_level) VALUES($1,'confidential')",
      [ownedId],
    );
    await expect(registry.execute(listRef, tool, { scope: 'owned' })).resolves.toMatchObject({
      replayed: true,
      dataLevel: 'confidential',
      undoId: null,
    });
    await context.pool.query('UPDATE cert_project SET owner_user_id=$2 WHERE id=$1', [
      ownedId,
      otherUser,
    ]);
    await expect(registry.execute(listRef, tool, { scope: 'owned' })).rejects.toMatchObject({
      code: 'TOOL_TARGET_CONFLICT',
    });
  } finally {
    await context.close();
  }
});

function answer(message: unknown, finish_reason = 'stop') {
  return {
    id: randomUUID(),
    object: 'chat.completion',
    choices: [{ index: 0, message, finish_reason }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: 0 },
  };
}
const invoke = (name: string, input: unknown) =>
  answer(
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: randomUUID(),
          type: 'function',
          function: { name, arguments: JSON.stringify(input) },
        },
      ],
    },
    'tool_calls',
  );

test('空白项目的 R01 和 R02 由已审阅技能进入真实内核，读取目标并计算或保留缺项', async () => {
  const context = await createIntegrationContext();
  try {
    const browser = await context.login();
    const owner = context.userId('MEMBER_A');
    const id = randomUUID(),
      goalId = randomUUID(),
      workspace = randomUUID(),
      version = randomUUID();
    const store = memoryStore();
    const file = await store.put(Buffer.from('合成空白注册项目。产品用途待人提供。'));
    await context.pool.query(
      "INSERT INTO cert_project(id,name,project_type,market,pathway,owner_user_id) VALUES($1,'合成空白项目','registration','US','待研判',$2)",
      [id, owner],
    );
    await context.pool.query(
      "INSERT INTO goal(id,project_id,owner_user_id,title,acceptance_criteria) VALUES($1,$2,$3,'注册立项','列首轮计划')",
      [goalId, id, owner],
    );
    await context.pool.query('INSERT INTO workspace(id,project_id) VALUES($1,$2)', [workspace, id]);
    await context.pool.query(
      "INSERT INTO workspace_version(id,workspace_id,project_id,number,author_type,summary,data_level) VALUES($1,$2,$3,1,'system','合成初版','internal')",
      [version, workspace, id],
    );
    await context.pool.query(
      "INSERT INTO workspace_file(version_id,path,sha256,byte_size,data_level,media_type) VALUES($1,'AGENTS.md',$2,$3,'internal','text/plain')",
      [version, file.sha256, file.byteSize],
    );
    await context.pool.query('UPDATE workspace SET current_version_id=$1 WHERE id=$2', [
      version,
      workspace,
    ]);
    await seedDevelopmentBudgetPolicy(context.pool, 'test');
    for (const [skill, path] of [
      ['R01', 'skills/R01-注册项目立项与倒排计划/SKILL.md'],
      ['R02', 'skills/R02-分类与申报路径研判/SKILL.md'],
    ] as const) {
      const draft = parseSkillDraftMarkdown(
        await readFile(new URL('../../../../' + path, import.meta.url), 'utf8'),
      );
      const staged = await stageSkillVersion(context.pool, draft);
      const released = await context.app.inject({
        method: 'POST',
        url: `/api/skills/${skill}/actions`,
        headers: browser.headers,
        payload: {
          action: 'publish',
          versionId: staged.id,
          contentSha256: staged.contentSha256,
          expectedRevision: 0,
          requestKey: randomUUID(),
        },
      });
      expect(released.statusCode).toBe(200);
      const created = await context.app.inject({
        method: 'POST',
        url: `/api/projects/${id}/conversations`,
        headers: browser.headers,
        payload: { requestKey: randomUUID(), goalId, permissionMode: 'full' },
      });
      expect(created.statusCode).toBe(200);
      const { conversation } = created.json();
      const posted = await context.app.inject({
        method: 'POST',
        url: `/api/conversations/${conversation.id}/messages`,
        headers: browser.headers,
        payload: {
          requestKey: randomUUID(),
          text:
            skill === 'R01'
              ? '合成立项，人员已给目标日 2031-01-08。'
              : '就这个空白器械项目，告诉我研判路径还缺哪些信息。',
        },
      });
      expect(posted.statusCode).toBe(200);
      const { runId } = posted.json();
      let phase = 0;
      const transport: GatewayTransport = {
        kind: 'fixture',
        async send(_model, request) {
          const latest = request.messages.at(-1);
          const previous: unknown = latest?.role === 'tool' ? JSON.parse(latest.content) : null;
          switch (phase++) {
            case 0:
              return invoke('skill_load', { id: skill });
            case 1:
              expect(previous).toMatchObject({ skill: { id: skill } });
              return invoke('cert_context', {});
            case 2:
              expect(previous).toMatchObject({
                project: { id, pathway: '待研判' },
                goal: { id: goalId, title: '注册立项' },
              });
              if (skill === 'R02')
                return invoke('ask_user', {
                  question: '请提供器械用途、技术特征及预期使用人群，便于研判路径。',
                  options: [],
                });
              return invoke('work_schedule_calculate', {
                targetDate: '2031-01-08',
                nodes: [
                  {
                    id: 'review',
                    name: '内部资料审核',
                    owner: '合成负责人',
                    durationDays: 2,
                    dependsOn: [],
                  },
                ],
              });
            case 3:
              expect(
                z.object({ latestStartDate: z.string() }).parse(previous).latestStartDate,
              ).toBe('2031-01-06');
              return invoke('ask_user', {
                question: '按目标日期倒排的最晚开始日是 2031-01-06。请确认工期和负责人。',
                options: [],
              });
            default:
              throw Error('意外的剧本调用');
          }
        },
      };
      const gateway = new ModelGateway(context.pool, browserModels, transport, {
        environment: 'test',
      });
      const result = await executeAgentRun(
        {
          pool: context.pool,
          store,
          models: browserModels,
          gateway,
          definitions: await buildAgentTools(store, 'registration'),
        },
        runId,
      );
      expect(result.status).toBe('waiting');
      expect(result.questionId).toBeTruthy();
      expect(result.reviewId).toBeUndefined();
      const invocations = await context.pool.query(
        'SELECT tool_name FROM tool_invocation WHERE run_id=$1 AND status=$2 ORDER BY created_at',
        [runId, 'completed'],
      );
      expect(invocations.rows.map(({ tool_name }) => tool_name)).toEqual(
        skill === 'R01'
          ? ['skill_load', 'cert_context', 'work_schedule_calculate', 'ask_user']
          : ['skill_load', 'cert_context', 'ask_user'],
      );
    }
  } finally {
    await context.close();
  }
});
