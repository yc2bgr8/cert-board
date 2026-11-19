import { fromBufferPromise } from 'yauzl';
import { crc32 } from 'node:zlib';
import type { DocumentFormat } from '@cert-board/shared';
import { documentFormatSchema, maximumIntakeBytes, maximumIntakeItems } from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { maximumDocumentBytes } from '../documents/docsvc-client.js';

export { maximumIntakeBytes, maximumIntakeItems };
export const maximumExpandedBytes = 256 * 1024 * 1024;
const maximumDepth = 3;

export type ArchiveFile = { path: string; bytes: Buffer };

export function intakePath(name: string) {
  const path = name.replaceAll('\\', '/').normalize('NFC');
  if (
    !path ||
    path.length > 1024 ||
    Buffer.byteLength(path, 'utf8') > 2400 ||
    /^(?:\/|[a-z]:)/iu.test(path) ||
    /[\p{Cc}\ufffd]/u.test(path) ||
    path
      .split('/')
      .some((segment) => !segment || segment === '.' || segment === '..' || segment.includes(':'))
  )
    throw new AppError(
      422,
      'INTAKE_PATH_INVALID',
      '压缩包含无法接受的路径，请整理文件名后重新打包。',
    );
  return path;
}

const exceeded = () =>
  new AppError(413, 'INTAKE_ARCHIVE_LIMIT', '压缩包超过允许的深度、文件数或展开大小。');

export async function expandIntakeArchive(bytes: Buffer, signal?: AbortSignal) {
  const files: ArchiveFile[] = [];
  const found = new Set<string>();
  let count = 0;
  let expanded = 0;
  async function expand(source: Buffer, parent: string, depth: number) {
    if (depth > maximumDepth) throw exceeded();
    signal?.throwIfAborted();
    const zip = await fromBufferPromise(source, { lazyEntries: true, validateEntrySizes: true });
    try {
      if (zip.entryCount > maximumIntakeItems) throw exceeded();
      for await (const entry of zip.eachEntry()) {
        signal?.throwIfAborted();
        if (++count > maximumIntakeItems) throw exceeded();
        if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000)
          throw new AppError(
            422,
            'INTAKE_LINK_UNSUPPORTED',
            '压缩包中含符号链接，请换用实际资料文件。',
          );
        const directory = entry.fileName.endsWith('/');
        const path = intakePath(
          parent + (directory ? entry.fileName.slice(0, -1) : entry.fileName),
        );
        if (directory) continue;
        if (found.has(path))
          throw new AppError(
            422,
            'INTAKE_PATH_DUPLICATE',
            '压缩包中有重复路径，请调整名称后重新导入。',
          );
        found.add(path);
        if (
          !Number.isSafeInteger(entry.uncompressedSize) ||
          entry.uncompressedSize > maximumDocumentBytes ||
          expanded + entry.uncompressedSize > maximumExpandedBytes ||
          (entry.uncompressedSize > 1024 * 1024 &&
            entry.uncompressedSize > 200 * entry.compressedSize)
        )
          throw exceeded();
        expanded += entry.uncompressedSize;
        const stream = await zip.openReadStreamPromise(entry);
        const blocks: Buffer[] = [];
        let total = 0;
        let checksum = 0;
        for await (const piece of stream) {
          signal?.throwIfAborted();
          const block = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
          total += block.length;
          if (total > entry.uncompressedSize) throw exceeded();
          checksum = crc32(block, checksum);
          blocks.push(block);
        }
        if (total !== entry.uncompressedSize || checksum !== entry.crc32)
          throw new AppError(
            422,
            'INTAKE_ENTRY_CORRUPT',
            '压缩包内有文件无法通过完整性校验，请重新打包。',
          );
        const content = Buffer.concat(blocks, total);
        if (/\.zip$/iu.test(path)) await expand(content, path + '!/', depth + 1);
        else files.push({ path, bytes: content });
      }
    } finally {
      zip.close();
    }
  }
  if (!bytes.length || bytes.length > maximumIntakeBytes) throw exceeded();
  try {
    await expand(bytes, '', 1);
    if (!files.length)
      throw new AppError(
        422,
        'INTAKE_ARCHIVE_EMPTY',
        '压缩包没有资料文件，请选择包含文件的压缩包。',
      );
  } catch (error) {
    if (signal?.aborted || error instanceof AppError) throw error;
    throw new AppError(
      422,
      'INTAKE_ZIP_INVALID',
      '文件无法作为 ZIP 展开，请核对格式及压缩包完整性。',
    );
  }
  return { files, expandedBytes: expanded };
}

export function intakeFormat(path: string): DocumentFormat | undefined {
  const ext = /\.([^./]+)$/u.exec(path.toLowerCase())?.[1];
  const parsed = documentFormatSchema.safeParse(ext);
  if (!parsed.success || parsed.data === 'estar') return undefined;
  return parsed.data;
}
