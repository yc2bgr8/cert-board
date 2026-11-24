import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderK05Draft } from '../apps/backend/src/knowledge/draft-template.ts';
import { SandboxClient } from '../apps/backend/src/sandbox/client.ts';
import { sandboxBaseUrl } from '../packages/shared/src/config.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
assert.ok(!args.length || (args.length === 1 && args[0] === '--docx'), '只接受可选参数 --docx');
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
let word;
if (args.includes('--docx')) {
  const code = await readFile(
    path.join(root, 'knowledge', 'k05', 'render-cover-letter.py'),
    'utf8',
  );
  const sandbox = new SandboxClient(sandboxBaseUrl('host'), 'host');
  const run = await sandbox.run({
    code,
    timeoutSeconds: 60,
    files: [{ name: 'draft.json', bytes: Buffer.from(JSON.stringify(draft)) }],
  });
  assert.equal(run.status, 'ok', 'Word 草稿或版面转换未通过，请核对隔离沙箱。');
  word = run.files;
  assert.deepEqual(word.map(({ path }) => path).sort(), [
    '510k-cover-letter.draft.docx',
    '510k-cover-letter.draft.pdf',
    '510k-cover-letter.sources.json',
  ]);
  const document = word.find(({ path }) => path.endsWith('.docx'));
  const map = word.find(({ path }) => path.endsWith('.json'));
  assert.equal(JSON.parse(map.bytes.toString('utf8')).wordSha256, document.sha256);
}
const reports = path.join(root, '.local');
await mkdir(reports, { recursive: true });
const target = await mkdtemp(path.join(reports, 'k05-cover-draft-'));
await writeFile(path.join(target, '510k-cover-letter.draft.md'), draft.markdown, {
  flag: 'wx',
  mode: 0o600,
});
if (word) {
  for (const file of word)
    await writeFile(path.join(target, file.path), file.bytes, { flag: 'wx', mode: 0o600 });
} else {
  await writeFile(
    path.join(target, '510k-cover-letter.sources.json'),
    JSON.stringify(draft.sourceMap, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
}
console.log(`已在 .local/${path.basename(target)} 保存合成 Cover Letter 草稿和来源表。`);
