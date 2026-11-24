import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderK05Draft } from '../apps/backend/src/knowledge/draft-template.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const documentId = '11111111-1111-4111-8111-111111111111';
const values = {
  submission_type: 'Traditional',
  draft_date: '2030-01-08',
  device_name: 'Synthetic device A',
  applicant_name: 'Synthetic applicant A',
};
const fields = Object.fromEntries(
  Object.entries(values).map(([name, value]) => [
    name,
    { value, source: { documentId, version: 1, page: 1, quote: `合成资料 ${name} ${value}` } },
  ]),
);
const page = Object.values(fields)
  .map(({ source }) => source.quote)
  .join('\n');
const template = await readFile(
  path.join(root, 'knowledge', 'k05', 'us-510k-cover-letter.yaml'),
  'utf8',
);
const draft = await renderK05Draft(template, fields, async (reference) =>
  reference.documentId === documentId && reference.version === 1 && reference.page === 1
    ? page
    : null,
);
assert.equal(draft.sourceMap.publication, 'draft');
assert.equal(draft.sourceMap.paragraphs.length, 5);
assert.ok(draft.sourceMap.missing.includes('contact_name'));
const reports = path.join(root, '.local');
await mkdir(reports, { recursive: true });
const target = await mkdtemp(path.join(reports, 'k05-cover-draft-'));
await writeFile(path.join(target, '510k-cover-letter.draft.md'), draft.markdown, {
  flag: 'wx',
  mode: 0o600,
});
await writeFile(
  path.join(target, '510k-cover-letter.sources.json'),
  JSON.stringify(draft.sourceMap, null, 2) + '\n',
  {
    flag: 'wx',
    mode: 0o600,
  },
);
console.log(`已在 .local/${path.basename(target)} 保存合成 Cover Letter 草稿和来源表。`);
