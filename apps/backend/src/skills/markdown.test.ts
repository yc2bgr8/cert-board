import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { parseSkillDraftMarkdown } from './markdown.js';

const sample = new URL('../../../../skills/R01-注册立项演示/SKILL.md', import.meta.url);

test('演示草稿校验所属 Agent、模式和必要的审查规则', async () => {
  const source = await readFile(sample, 'utf8');
  expect(parseSkillDraftMarkdown(source).metadata).toMatchObject({
    id: 'R01',
    agentCode: 'registration',
    requiredChecks: ['V1', 'V3'],
    minimumEvidence: 2,
  });
  expect(() => parseSkillDraftMarkdown(source.replace('[V1, V3]', '[V3]'))).toThrow();
  expect(() => parseSkillDraftMarkdown(source.replace('level: 2', 'level: 3'))).toThrow();
  expect(() => parseSkillDraftMarkdown(source.replace('id: R01', 'id: &skill R01'))).toThrow();
});
