import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../apps/backend/src/api/errors.ts';
import { previewCredentialLedger } from '../apps/backend/src/documents/credential-ledger-preview.ts';

async function boundedRead(filename, bytes) {
  const metadata = await stat(filename);
  if (!metadata.isFile() || metadata.size > bytes) throw new Error('上传文件无效或过大。');
  const content = await readFile(filename);
  if (content.length > bytes) throw new Error('上传文件过大。');
  return content;
}

async function main() {
  const [csv, reference, ...rest] = process.argv.slice(2);
  if (!csv || !reference || rest.length) throw new Error('用法不正确。');
  const max = 8 * 1024 * 1024;
  const [bytes, state] = await Promise.all([boundedRead(csv, max), boundedRead(reference, max)]);
  const snapshot = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(state));
  const report = previewCredentialLedger(path.basename(csv), bytes, snapshot);
  const root = fileURLToPath(new URL('../.local/', import.meta.url));
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'credential-ledger-preview-'));
  await writeFile(path.join(directory, 'preview.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  const { new: added, unchanged, conflict, error } = report.counts;
  console.log(
    `预览已存入 .local/${path.basename(directory)}/，新增 ${added}、相同 ${unchanged}、冲突 ${conflict}、错误 ${error}。`,
  );
}

main().catch((error) => {
  console.error(
    error instanceof AppError ? error.message : '无法生成预览，请核对 CSV、成员与证照快照文件。',
  );
  process.exitCode = 1;
});
