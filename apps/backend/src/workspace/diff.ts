import { diffLines } from 'diff';
import {
  workspaceFileDescriptorSchema,
  workspacePathSchema,
  workspaceTextDiffOptionsSchema,
  workspaceTextDiffSchema,
  type WorkspaceFileDescriptor,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { sliceUnicodeText } from './text.js';

export function compareFileManifests(
  before: readonly WorkspaceFileDescriptor[],
  after: readonly WorkspaceFileDescriptor[],
) {
  function index(files: readonly WorkspaceFileDescriptor[]) {
    if (files.length > 10000)
      throw new AppError(413, 'WORKSPACE_FILE_LIMIT', '工作区文件超过比较上限，请先缩小范围。');
    const map = new Map<string, WorkspaceFileDescriptor>();
    for (const file of files) {
      const parsed = workspaceFileDescriptorSchema.safeParse(file);
      if (!parsed.success)
        throw new AppError(
          500,
          'WORKSPACE_MANIFEST_INVALID',
          '工作区文件清单无效，请联系维护人员核对版本。',
        );
      if (map.has(parsed.data.path))
        throw new AppError(
          409,
          'WORKSPACE_PATH_COLLISION',
          '文件名在NFC规范化后重复，请检查路径后重试。',
        );
      map.set(parsed.data.path, parsed.data);
    }
    return map;
  }
  const old = index(before),
    next = index(after);
  const changes: Array<{
    path: string;
    change: 'added' | 'modified' | 'deleted';
    before: WorkspaceFileDescriptor | null;
    after: WorkspaceFileDescriptor | null;
  }> = [];
  for (const pathname of [...new Set([...old.keys(), ...next.keys()])].sort()) {
    const previous = old.get(pathname) ?? null,
      current = next.get(pathname) ?? null;
    if (
      previous &&
      current &&
      previous.sha256 === current.sha256 &&
      previous.byteSize === current.byteSize &&
      previous.dataLevel === current.dataLevel &&
      previous.mediaType === current.mediaType
    )
      continue;
    changes.push({
      path: workspacePathSchema.parse(pathname),
      change: !previous ? 'added' : !current ? 'deleted' : 'modified',
      before: previous,
      after: current,
    });
  }
  return changes;
}

type Line = {
  kind: 'context' | 'added' | 'removed';
  oldLine: number | null;
  newLine: number | null;
  text: string;
  ending: '' | '\n' | '\r\n';
};
export function compareTextLines(before: string, after: string, options: unknown = {}) {
  const parsed = workspaceTextDiffOptionsSchema.safeParse(options);
  if (!parsed.success)
    throw new AppError(
      400,
      'WORKSPACE_DIFF_OPTIONS',
      '差异分页参数无效，请使用nextOffset继续，每次最多200行。',
    );
  const { offset, limit } = parsed.data;
  const unavailable = () =>
    workspaceTextDiffSchema.parse({
      available: false,
      lines: [],
      added: null,
      removed: null,
      totalLines: null,
      offset,
      hasMore: false,
      nextOffset: null,
      warning: '文本差异超过计算上限，请按文件读取内容或查看哈希变化。',
    });
  if (
    before.length > 1_000_000 ||
    after.length > 1_000_000 ||
    before.split('\n').length > 10000 ||
    after.split('\n').length > 10000
  )
    return unavailable();
  const changes = diffLines(before, after, {
    oneChangePerToken: true,
    timeout: 200,
    maxEditLength: 4000,
  });
  if (!changes) return unavailable();
  let oldLine = 1,
    newLine = 1,
    added = 0,
    removed = 0;
  const lines: Line[] = changes.map((change) => {
    const kind = change.added ? 'added' : change.removed ? 'removed' : 'context';
    const ending = change.value.endsWith('\r\n') ? '\r\n' : change.value.endsWith('\n') ? '\n' : '';
    const text = ending ? change.value.slice(0, -ending.length) : change.value;
    const entry: Line = {
      kind,
      oldLine: kind === 'added' ? null : oldLine,
      newLine: kind === 'removed' ? null : newLine,
      text,
      ending,
    };
    if (kind !== 'added') oldLine++;
    if (kind !== 'removed') newLine++;
    if (kind === 'added') added++;
    if (kind === 'removed') removed++;
    return entry;
  });
  if (offset > lines.length)
    throw new AppError(
      400,
      'WORKSPACE_DIFF_OFFSET',
      '差异读取位置超出范围，请使用上次返回的nextOffset。',
    );
  const end = Math.min(offset + limit, lines.length);
  const page = lines.slice(offset, end).map((line) => {
    const value = sliceUnicodeText(line.text, { offset: 0, limit: 1000 });
    return { ...line, text: value.text, lineTruncated: value.truncated };
  });
  return workspaceTextDiffSchema.parse({
    available: true,
    lines: page,
    added,
    removed,
    totalLines: lines.length,
    offset,
    hasMore: end < lines.length,
    nextOffset: end < lines.length ? end : null,
    warning: page.some((line) => line.lineTruncated)
      ? '部分长行已截断，请读取文件查看完整内容。'
      : null,
  });
}
