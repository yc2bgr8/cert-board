import { readFile } from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { loadAgentDefinition, loadAgentSkill, parseAgentDefinition } from './definitions.js';
import { skillLoadInputSchema } from '@cert-board/shared';

afterEach(() => vi.unstubAllEnvs());
test('两个Agent按固定服务端索引选不同技能，系统提示不混入技能全文', async () => {
  const registration = await loadAgentDefinition('registration', 'test');
  const maintenance = await loadAgentDefinition('maintenance', 'test');
  expect(registration.name).toBe('注册Agent');
  expect(maintenance.name).toBe('维护Agent');
  expect(registration.skills.map((skill) => skill.id)).toEqual(['R09']);
  expect(maintenance.skills.map((skill) => skill.id)).toEqual(['M02']);
  expect(registration.systemPrompt).toContain('R09@0.1.0');
  expect(registration.systemPrompt).not.toContain('doc_search 是大小写不敏感');
  expect(maintenance.systemPrompt).not.toContain('R09@');
  expect(registration.systemPrompt).not.toMatch(/K170825|K170285/);
});
test('技能正文与审核策略版本一致，M02 草稿限定官方工具、检索范围和空回执结论', async () => {
  const registration = await loadAgentSkill('registration', { id: 'R09' }, 'test');
  const maintenance = await loadAgentSkill('maintenance', { id: 'M02', version: '0.1.0' }, 'test');
  expect(registration.skill.agentCode).toBe('registration');
  expect(registration.body).toContain('predicate');
  expect(registration.body).toContain('decisions');
  expect(registration.body).not.toMatch(/K\d{6}|D0(?:01|18|35)/);
  expect(registration.attachments).toEqual([]);
  expect(maintenance.reviewPolicy.skill).toEqual({ id: 'M02', version: '0.1.0' });
  expect(maintenance.reviewPolicy.requiredChecks).toEqual(['V1', 'V3']);
  expect(maintenance.reviewPolicy.minimumEvidence).toBe(2);
  expect(maintenance.publication).toBe('draft');
  expect(maintenance.developmentOnly).toBe(true);
  expect(maintenance.body).toContain('official_lookup');
  expect(maintenance.body).toContain('每个商品名，各建一条「公开列名商品名」主张');
  expect(maintenance.body).toContain('`sources` 引用包含该名称的已读档案页');
  expect(maintenance.body).toContain('只用资料中明确给出且可以公开查询的编号和名称');
  expect(maintenance.body).toContain('只在成功回执明确返回零条时写「本次查询条件下未查到」');
});
test('不允许路径输入、跨Agent技能或未登记版本', async () => {
  for (const code of ['../registration', 'sales', null])
    await expect(loadAgentDefinition(code, 'test')).rejects.toMatchObject({
      code: 'AGENT_DEFINITION_UNAVAILABLE',
    });
  for (const input of [
    { id: 'M02' },
    { id: 'R09', version: '9.0.0' },
    { id: 'R09', path: '.env.local' },
  ])
    await expect(loadAgentSkill('registration', input, 'test')).rejects.toMatchObject({
      code: 'SKILL_UNAVAILABLE',
    });
  expect(skillLoadInputSchema.safeParse({ id: '../R09' }).success).toBe(false);
});
test('草稿生产环境拒绝，传test也不能越过全局production环境', async () => {
  await expect(loadAgentDefinition('registration', 'production')).rejects.toMatchObject({
    statusCode: 403,
  });
  await expect(loadAgentSkill('maintenance', { id: 'M02' }, 'production')).rejects.toMatchObject({
    code: 'SKILL_UNAVAILABLE',
  });
  vi.stubEnv('NODE_ENV', 'production');
  await expect(loadAgentDefinition('registration', 'test')).rejects.toMatchObject({
    statusCode: 403,
  });
  await expect(loadAgentSkill('registration', { id: 'R09' }, 'test')).rejects.toMatchObject({
    code: 'SKILL_UNAVAILABLE',
  });
});
test('定义YAML拒绝重复键、别名、未知字段及错配索引，错误不回显原文', async () => {
  const source = await readFile(
    new URL('../../../../agents/registration/0.1.0.md', import.meta.url),
    'utf8',
  );
  for (const value of [
    `${/^---\r?\n[\s\S]*?\r?\n---/.exec(source)![0]}\n\n`,
    source.replace('code: registration', 'code: registration\ncode: registration'),
    source.replace('name: 注册Agent', 'name: &private PRIVATE_CONFIG_TEXT'),
    source.replace('code: registration', 'apiKey: PRIVATE_CONFIG_TEXT\ncode: registration'),
    source.replace('id: R09', 'id: M02'),
  ]) {
    try {
      parseAgentDefinition(value, 'registration', 'test');
      throw new Error('应拒绝');
    } catch (error) {
      expect(error).toMatchObject({ code: 'AGENT_DEFINITION_UNAVAILABLE' });
      expect((error as Error).message).not.toContain('PRIVATE_CONFIG_TEXT');
    }
  }
});
