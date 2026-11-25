import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localProcessEnvironment } from './dev.mjs';
import { loadVerifiedK14 } from './k14-public.mjs';

const image = 'cert-board-docsvc-test';
const imagePattern = /^sha256:[a-f0-9]{64}$/u;
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function indexedPdfPages(value, entry) {
  if (
    value?.sha256 !== entry.sha256 || value?.byteSize !== entry.bytes || value?.kind !== 'pdf' ||
    !Number.isSafeInteger(value.pageCount) || value.pageCount < 1 || value.pageCount > 800 ||
    !Array.isArray(value.pages) || value.pages.length !== value.pageCount
  ) throw new Error('摘要解析回执与原件不符。');

  return value.pages.map((page, index) => {
    if (
      page?.page !== index + 1 || page.locatorKind !== 'physical_page' ||
      !['text', 'ocr'].includes(page.method) || typeof page.text !== 'string'
    ) throw new Error('摘要解析回执的页码或文字无效。');
    return { page: page.page, method: page.method, text: page.text };
  });
}

function docker(args, input) {
  const command = ['--context', 'default', ...args];
  const windows = process.platform === 'win32';
  return spawnSync(
    windows ? 'wsl.exe' : 'docker',
    windows ? ['-d', 'Ubuntu-24.04', '--exec', 'docker', ...command] : command,
    {
      env: localProcessEnvironment(), input, encoding: 'utf8', timeout: 180_000,
      maxBuffer: 48 * 1024 * 1024, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    },
  );
}

async function extract(snapshot) {
  const archiveRoot = fileURLToPath(new URL('../.local/k14/', import.meta.url));
  const outputRoot = fileURLToPath(new URL('../.local/k14-pages/', import.meta.url));
  const source = await loadVerifiedK14(archiveRoot, snapshot);
  if (source.dataset !== 'A') throw new Error('逐页解析仅接收已校验的集 A 档案。');
  const parser = docker(['image', 'inspect', '--format', '{{.Id}}', image]);
  const parserImage = parser.stdout?.trim();
  if (parser.status !== 0 || !imagePattern.test(parserImage ?? ''))
    throw new Error('缺少本机 Docsvc 测试镜像，请先构建。');
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const pending = path.join(outputRoot, '.' + snapshot + '.partial');
  await mkdir(pending, { mode: 0o700 });
  const files = [];
  for (const entry of source.pdfs) {
    if (entry.status !== 'saved') {
      files.push({ file: entry.file, status: 'source_unavailable' });
      continue;
    }
    const input = await readFile(path.join(source.directory, entry.file));
    if (sha256(input) !== entry.sha256) throw new Error('解析前摘要原件发生变化。');
    const output = docker([
      'run', '--rm', '--network', 'none', '--pull=never', '-i',
      '--read-only', '--tmpfs', '/tmp:mode=1777', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--memory', '2g', '--cpus', '2', '--pids-limit', '128',
      '--entrypoint', '/app/.venv/bin/python', parserImage, '/app/doc_worker.py', 'parse', 'pdf',
    ], input);
    let pages;
    try {
      if (output.status === 0) pages = indexedPdfPages(JSON.parse(output.stdout), entry);
    } catch {
      // 报告只记固定分类，省略公开文档和解析异常正文。
    }
    if (!pages) {
      files.push({ file: entry.file, status: 'parse_failed', sourceSha256: entry.sha256 });
      continue;
    }
    const result = json({ sourceSha256: entry.sha256, pages });
    const file = entry.file.slice(0, -4) + '.pages.json';
    await writeFile(path.join(pending, file), result, { flag: 'wx', mode: 0o600 });
    files.push({
      file, status: 'parsed', sourceSha256: entry.sha256, sha256: sha256(result),
      pages: pages.length, blankPages: pages.filter((page) => !page.text.trim()).length,
    });
  }
  const ready = files.filter(({ status }) => status === 'parsed');
  const counts = {
    parsed: ready.length,
    sourceMissing: files.filter(({ status }) => status === 'source_unavailable').length,
    parseFailed: files.filter(({ status }) => status === 'parse_failed').length,
    pages: ready.reduce((total, item) => total + item.pages, 0),
    blankPages: ready.reduce((total, item) => total + item.blankPages, 0),
  };
  await writeFile(path.join(pending, 'manifest.json'), json({
    version: 1, sourceSnapshot: snapshot, through: source.through, parserImage, files, counts,
  }), { flag: 'wx', mode: 0o600 });
  await rename(pending, path.join(outputRoot, snapshot));
  console.log(JSON.stringify({ snapshot, ...counts }));
  if (ready.length === 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [snapshot, extra] = process.argv.slice(2);
    if (!snapshot || extra) throw new Error('使用 pnpm k14:extract-a <档案编号>。');
    await extract(snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    console.error(/^[\p{Script=Han}][\p{Script=Han} A-Za-z0-9_、。 -]{0,100}$/u.test(message)
      ? message : '公开摘要逐页解析未完成。');
    process.exitCode = 1;
  }
}
