import { readFile } from 'node:fs/promises';
import { parseBackendConfig } from '@cert-board/shared';
import { createDependencies } from '../dependencies.js';
import { parseSkillDraftMarkdown } from './markdown.js';
import { stageSkillVersion } from './service.js';

async function main() {
  const file = process.argv[2];
  const config = parseBackendConfig(process.env);
  if (!file || process.argv.length !== 3 || config.NODE_ENV === 'production')
    throw new Error('SKILL_STAGE_INVALID');
  const draft = parseSkillDraftMarkdown(await readFile(file, 'utf8'));
  const dependencies = createDependencies(config);
  try {
    const version = await stageSkillVersion(dependencies.database, draft);
    console.log(
      `技能 ${draft.metadata.id} ${draft.metadata.version}${version.created ? '已登记草稿' : '已有相同草稿'}。请在浏览器打开技能审核并确认发布。`,
    );
  } finally {
    await dependencies.close();
  }
}

main().catch(() => {
  console.error('无法登记技能草稿。请检查开发库迁移、草稿内容和版本编号。');
  process.exitCode = 1;
});
