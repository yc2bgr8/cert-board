import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import {
  codeRunInputSchema,
  codeRunOutputSchema,
  codeRunSaveInputSchema,
  type DataLevel,
  type ToolMetadata,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import {
  resolveWorkspaceToolContext,
  workspaceVersionToken,
  writeDraftArtifact,
} from '../workspace/service.js';
import { documentInProject, highestDocumentLevel } from './document-context.js';
import type { ToolDefinition, ToolExecutionContext } from './registry.js';
import { sandboxMaximumBytes, type SandboxClient } from '../sandbox/client.js';
import { workspaceDraftUndo } from './workspace-tools.js';

type RunInput = z.infer<typeof codeRunInputSchema>;
type RunOutput = z.infer<typeof codeRunOutputSchema>;
type Outcome = Awaited<ReturnType<SandboxClient['run']>>;
const inputLimit = () =>
  new AppError(413, 'SANDBOX_INPUT_LIMIT', '输入合计超过 12 MiB，请减少文件后重试。');
const mediaTypes = new Map([
  ['.pdf', 'application/pdf'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'],
]);

async function scope(
  ctx: ToolExecutionContext,
  view: 'draft' | 'current' = 'draft',
  write = false,
) {
  if (!ctx.projectId)
    throw new AppError(400, 'WORKSPACE_PROJECT_REQUIRED', '请先进入项目对话，再读取工作区文件。');
  return resolveWorkspaceToolContext(
    ctx.tx,
    ctx.actor,
    ctx.projectId,
    ctx.conversationId,
    view,
    write,
  );
}

async function inputFiles(
  ctx: ToolExecutionContext,
  store: DocumentBlobStore,
  inputs: RunInput['inputs'],
) {
  const files: { name: string; bytes: Buffer }[] = [];
  const levels: DataLevel[] = [ctx.maxDataLevel];
  const documents: RunOutput['documents'] = [];
  const names = new Set<string>();
  let used = 0;
  let readsWorkspace = false;
  for (const input of inputs) {
    if (names.has(input.name))
      throw new AppError(
        400,
        'SANDBOX_DUPLICATE_INPUT',
        '输入别名重复，请为每个文件使用不同名称。',
      );
    names.add(input.name);
    let digest: string;
    let size: number;
    if (input.source === 'workspace') {
      readsWorkspace = true;
      const workspace = await scope(ctx, input.view);
      const row = workspace.files.get(input.path);
      if (!row)
        throw new AppError(
          404,
          'SANDBOX_INPUT_NOT_FOUND',
          '找不到该工作区文件，请先用 ws_list 定位。',
        );
      digest = row.sha256;
      size = row.byteSize;
      levels.push(workspace.dataLevel, row.dataLevel);
    } else {
      const document = await documentInProject(ctx, input.documentId);
      const row = (
        await ctx.tx.query<{ content_sha256: string; byte_size: string }>(
          `SELECT content_sha256,byte_size FROM document_version WHERE document_id=$1 AND version_no=$2`,
          [input.documentId, input.version],
        )
      ).rows[0];
      if (!row)
        throw new AppError(
          404,
          'SANDBOX_INPUT_NOT_FOUND',
          '找不到该资料版本，请先用 doc_search 获取定位。',
        );
      digest = row.content_sha256;
      size = Number(row.byte_size);
      levels.push(document.dataLevel);
      documents.push({ id: document.id, version: input.version });
    }
    used += size;
    if (!Number.isSafeInteger(used) || used > sandboxMaximumBytes) throw inputLimit();
    const bytes = await store.get(digest);
    if (bytes.byteLength !== size || createHash('sha256').update(bytes).digest('hex') !== digest)
      throw new AppError(
        502,
        'SANDBOX_INPUT_INTEGRITY',
        '输入文件与版本记录不一致，请联系维护人员。',
      );
    files.push({ name: input.name, bytes });
  }
  return { files, dataLevel: highestDocumentLevel(levels), documents, readsWorkspace };
}

function documentType(path: string) {
  const extension = posix.extname(path.toLowerCase());
  return mediaTypes.get(extension) ?? 'application/octet-stream';
}

function summary(
  result: Outcome,
  input: Pick<Awaited<ReturnType<typeof inputFiles>>, 'documents' | 'readsWorkspace'>,
  directory?: string,
): RunOutput {
  const { files, stdout, stderr, stdoutTruncated, stderrTruncated, ...meta } = result;
  const slice = (value: string) => Array.from(value).slice(0, 2_500).join('');
  const visibleStdout = slice(stdout);
  const visibleStderr = slice(stderr);
  const summarized = {
    ...meta,
    ...input,
    stdout: visibleStdout,
    stderr: visibleStderr,
    stdoutTruncated: stdoutTruncated || visibleStdout !== stdout,
    stderrTruncated: stderrTruncated || visibleStderr !== stderr,
    outputCount: files.length,
    outputHashes: files.map(({ sha256 }) => sha256),
    files: files.slice(0, 12).map(({ path, byteSize, sha256 }) => ({
      path,
      byteSize,
      sha256,
      workspacePath: directory ? `${directory}/${path}` : null,
    })),
  };
  while (summarized.files.length && Buffer.byteLength(JSON.stringify(summarized), 'utf8') > 45_000)
    summarized.files.pop();
  return codeRunOutputSchema.parse(summarized);
}

function metadata(save: boolean): ToolMetadata {
  return {
    name: save ? 'code_run_save' : 'code_run',
    version: 'builtin-code-sandbox-v1',
    publication: 'published',
    effect: save ? 'reversible_write' : 'read',
    modes: save ? ['ask', 'full'] : ['read_only', 'ask', 'full'],
    approvalInAsk: false,
    authorizationAction: save ? 'workspace.write' : 'workspace.read',
    outputDataLevel: 'dynamic',
    description: {
      purpose: save
        ? '运行 Python 并把成功产出作为新文件写进本对话工作副本。'
        : '在离线沙箱中运行 Python，返回日志和临时产出的哈希与文件名。',
      whenToUse: '计算表格、抽取或合并 PDF、生成文档、离线试验脚本。',
      avoid: save
        ? '只需查看运行结果时用 code_run；不保存工作区版本，不写决定记录。'
        : '保留结果文件时用 code_run_save；查原文用 doc_read；外部资料用批准的网页工具。',
      parameters:
        'code 为 Python，timeoutSeconds 为 1 至 120 秒，inputs 为工作区路径或资料 UUID 加版本。输入以 name 放在 inputs/，产出写在 outputs/。资料若没有原件，内容是已有版本的解析 JSON。日志和产出明细会截断，已有产出从 ws_list 查看。' +
        (save
          ? 'outputDirectory 为工作副本相对目录，expectedDraftVersion 取 ws_list，不覆盖既有文件。'
          : '临时文件随运行清理。'),
      example: save
        ? {
            code: 'from pathlib import Path\nPath("outputs/计算.txt").write_text("3", encoding="utf-8")',
            timeoutSeconds: 10,
            inputs: [],
            outputDirectory: '交付/计算',
            expectedDraftVersion: 1,
          }
        : { code: 'print(sum([1, 2, 3]))', timeoutSeconds: 10, inputs: [] },
    },
  };
}

export function buildSandboxTools(
  store: DocumentBlobStore,
  client: Pick<SandboxClient, 'run'>,
): ToolDefinition[] {
  const run = async (ctx: ToolExecutionContext, data: RunInput) => {
    const input = await inputFiles(ctx, store, data.inputs);
    const output = await client.run(
      { code: data.code, timeoutSeconds: data.timeoutSeconds, files: input.files },
      ctx.signal,
    );
    return { output, input };
  };
  const refresh = async (ctx: ToolExecutionContext, cached: unknown) => {
    const result = codeRunOutputSchema.parse(cached);
    const levels: DataLevel[] = [ctx.maxDataLevel];
    for (const reference of result.documents)
      levels.push((await documentInProject(ctx, reference.id)).dataLevel);
    if (result.readsWorkspace || result.files.some((file) => file.workspacePath))
      levels.push((await scope(ctx)).dataLevel);
    return highestDocumentLevel(levels);
  };
  return [
    {
      metadata: metadata(false),
      inputSchema: codeRunInputSchema,
      outputSchema: codeRunOutputSchema,
      refreshDataLevel: refresh,
      async execute(ctx, raw) {
        const { output, input } = await run(ctx, codeRunInputSchema.parse(raw));
        return {
          data: summary(output, {
            documents: input.documents,
            readsWorkspace: input.readsWorkspace,
          }),
          dataLevel: input.dataLevel,
        };
      },
    },
    {
      metadata: metadata(true),
      inputSchema: codeRunSaveInputSchema,
      outputSchema: codeRunOutputSchema,
      undo: workspaceDraftUndo(store),
      refreshDataLevel: refresh,
      async execute(ctx, raw) {
        const data = codeRunSaveInputSchema.parse(raw);
        const current = await scope(ctx, 'draft', true);
        const { output, input } = await run(ctx, data);
        if (output.status !== 'ok' || !output.files.length)
          throw new AppError(
            422,
            'SANDBOX_NO_SAVED_OUTPUT',
            '程序未完成或 outputs/ 为空。可先用 code_run 查看日志。',
          );
        if (ctx.signal?.aborted)
          throw new AppError(409, 'SANDBOX_RUN_STOPPED', '运行已经停止，未登记运行产出。');
        const dataLevel = highestDocumentLevel([input.dataLevel, current.dataLevel]);
        for (const file of output.files) {
          await writeDraftArtifact(ctx.tx, store, ctx.actor, current.draft!.id, {
            path: `${data.outputDirectory}/${file.path}`,
            bytes: file.bytes,
            dataLevel,
            mediaType: documentType(file.path),
          });
        }
        return {
          data: summary(
            output,
            { documents: input.documents, readsWorkspace: true },
            data.outputDirectory,
          ),
          dataLevel,
          afterVersion: await workspaceVersionToken(ctx.tx, ctx.actor, current.draft!.id),
        };
      },
    },
  ];
}
