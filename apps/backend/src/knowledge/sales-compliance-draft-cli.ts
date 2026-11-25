import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  buildSyntheticSalesComplianceDraft,
  salesSourceKey,
  syntheticSalesSourceManifest,
} from './sales-compliance-draft.js';

async function main() {
  if (process.argv.length !== 2) throw new Error('只运行固定合成样本。');
  const root = new URL('../../../../', import.meta.url);
  const sourceDirectory = new URL('fixtures/s01/', root);
  const actualSources = await realpath(fileURLToPath(sourceDirectory));
  const fixture = z
    .strictObject({
      request: z.unknown(),
      pages: syntheticSalesSourceManifest,
    })
    .parse(JSON.parse(await readFile(new URL('fixtures/s01/synthetic-report.json', root), 'utf8')));
  const byLocation = new Map(fixture.pages.map((page) => [salesSourceKey(page), page]));
  const draft = await buildSyntheticSalesComplianceDraft(fixture.request, async (ref) => {
    const source = byLocation.get(salesSourceKey(ref));
    return source
      ? {
          subject: source.subject,
          level: source.level,
          async readText() {
            const file = await realpath(fileURLToPath(new URL(source.bodyFile, sourceDirectory)));
            if (path.dirname(file) !== actualSources) throw new Error('合成资料文件位置无效。');
            return readFile(file, 'utf8');
          },
        }
      : null;
  });
  const local = fileURLToPath(new URL('.local/', root));
  await mkdir(local, { recursive: true });
  const actualRoot = await realpath(fileURLToPath(root));
  const actualLocal = await realpath(local);
  if (path.relative(actualRoot, actualLocal) !== '.local')
    throw new Error('本机输出目录位置无效。');
  const target = await mkdtemp(path.join(actualLocal, 's01-synthetic-'));
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
