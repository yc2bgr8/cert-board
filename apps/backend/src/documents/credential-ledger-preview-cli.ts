import { mkdtemp, open, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { AppError } from '../api/errors.js';
import { previewCredentialLedger } from './credential-ledger-preview.js';

async function boundedRead(filename: string, limit: number) {
  const file = await open(filename, 'r');
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > limit) throw new Error('上传文件无效或过大。');
    const buffer = Buffer.allocUnsafe(metadata.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await file.stat();
    if (
      offset !== metadata.size ||
      after.size !== metadata.size ||
      after.mtimeMs !== metadata.mtimeMs
    )
      throw new Error('文件在读取中变化，请重新导出后预览。');
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}

async function main() {
  const [csv, reference, ...rest] = process.argv.slice(2);
  if (!csv || !reference || rest.length) throw new Error('用法不正确。');
  const max = 8 * 1024 * 1024;
  const [bytes, state] = await Promise.all([boundedRead(csv, max), boundedRead(reference, max)]);
  const snapshot = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(state));
  const report = previewCredentialLedger(path.basename(csv), bytes, snapshot);
  const directory = await mkdtemp(path.join(homedir(), '.cert-board-ledger-preview-'));
  await writeFile(path.join(directory, 'preview.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  const { new: added, unchanged, conflict, error } = report.counts;
  console.log(
    `预览已存入 ${directory}，新增 ${added}、相同 ${unchanged}、冲突 ${conflict}、错误 ${error}。`,
  );
}

main().catch((error) => {
  console.error(
    error instanceof AppError ? error.message : '无法生成预览，请核对 CSV、成员与证照快照文件。',
  );
  process.exitCode = 1;
});
