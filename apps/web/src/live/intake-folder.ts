import { zipSync, type Zippable } from 'fflate';
import { maximumIntakeBytes, maximumIntakeItems } from '@cert-board/shared';
import { ApiError } from './api.js';

export async function packageIntakeFolder(files: readonly File[]) {
  if (
    !files.length ||
    files.length > maximumIntakeItems ||
    files.reduce((total, file) => total + file.size, 0) > maximumIntakeBytes
  )
    throw new ApiError(413, 'INTAKE_FOLDER_LIMIT', '目录内容为空或超过导入上限，请拆分后重试。');
  const entries: Zippable = Object.create(null);
  let folder = '';
  for (const file of files) {
    const path = file.webkitRelativePath.normalize('NFC');
    const parts = path.split('/');
    if (
      parts.length < 2 ||
      parts.some((part) => !part || part === '.' || part === '..' || /[:\\]/u.test(part)) ||
      Object.hasOwn(entries, path)
    )
      throw new ApiError(400, 'INTAKE_FOLDER_PATH', '目录含重复或无效路径，请调整文件名后重试。');
    folder ||= parts[0]!;
    if (folder !== parts[0])
      throw new ApiError(400, 'INTAKE_FOLDER_PATH', '一次请选择一个资料目录。');
    entries[path] = new Uint8Array(await file.arrayBuffer());
  }
  const ordered = Object.fromEntries(
    Object.keys(entries)
      .sort()
      .map((path) => [path, entries[path]!]),
  );
  const zip = zipSync(ordered, { level: 0, mtime: new Date(2000, 0, 1) });
  if (zip.length > maximumIntakeBytes)
    throw new ApiError(413, 'INTAKE_FOLDER_LIMIT', '目录打包后超过 192 MiB，请拆分后重试。');
  return new File([Uint8Array.from(zip)], folder + '.zip', { type: 'application/zip' });
}
