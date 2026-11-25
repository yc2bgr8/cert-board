import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { documentCitationSchema } from '@cert-board/shared';
import { buildSyntheticSalesComplianceDraft } from './sales-compliance-draft.js';

async function main() {
  if (process.argv.length !== 2) throw new Error('只运行固定合成样本。');
  const root = new URL('../../../../', import.meta.url);
  const fixture = z
    .strictObject({
      request: z.unknown(),
      pages: documentCitationSchema
        .omit({ quote: true })
        .extend({ text: z.string() })
        .array()
        .max(12),
    })
    .parse(JSON.parse(await readFile(new URL('fixtures/s01/synthetic-report.json', root), 'utf8')));
  const draft = await buildSyntheticSalesComplianceDraft(
    fixture.request,
    async (ref) =>
      fixture.pages.find(
        (page) =>
          page.documentId === ref.documentId &&
          page.version === ref.version &&
          page.page === ref.page,
      )?.text ?? null,
  );
  const local = fileURLToPath(new URL('.local/', root));
  await mkdir(local, { recursive: true });
  const target = await mkdtemp(path.join(local, 's01-synthetic-'));
  await writeFile(path.join(target, 'sales-compliance.draft.md'), draft.markdown, {
    flag: 'wx',
    mode: 0o600,
  });
  await writeFile(
    path.join(target, 'sales-compliance.sources.json'),
    JSON.stringify(draft.sources, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  console.log(
    `S01 合成草稿已存入 .local/${path.basename(target)}/，${draft.sources.references.length} 条有来源，${draft.issues.length} 条待核。`,
  );
}

main().catch(() => {
  console.error('S01 合成草稿生成失败，请检查测试夹具和项目依赖。');
  process.exitCode = 1;
});
