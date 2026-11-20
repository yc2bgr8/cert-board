import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sandboxBaseUrl, sandboxResultSchema, type BackendConfig } from '@cert-board/shared';
import { AppError } from '../api/errors.js';

export const sandboxMaximumBytes = 12 * 1024 * 1024;
export const sandboxWorkTimeMs = 170_000;
const responseMaximumBytes = 18 * 1024 * 1024;
const errorShape = z.object({ code: z.string().regex(/^SANDBOX_[A-Z0-9_]{1,64}$/u) });
const checksum = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');
const invalid = () =>
  new AppError(502, 'SANDBOX_RESPONSE_INVALID', '沙箱结果校验失败，请联系维护人员检查服务。');

type RunInput = { code: string; timeoutSeconds: number; files: { name: string; bytes: Buffer }[] };

async function readResponse(response: Response) {
  const limit = response.ok ? responseMaximumBytes : 4096;
  if (!response.body || Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw invalid();
  }
  const reader = response.body.getReader();
  const blocks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) throw invalid();
      blocks.push(next.value);
    }
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(blocks, size)),
      ) as unknown;
    } catch {
      throw invalid();
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Transport for the fixed, isolated execution service. */
export class SandboxClient {
  readonly #address: string;

  constructor(address: string, runtime: BackendConfig['CONTAINER_RUNTIME']) {
    const expected = sandboxBaseUrl(runtime);
    if (!URL.canParse(address) || new URL(address).href !== expected)
      throw new AppError(500, 'SANDBOX_CONFIG_INVALID', '沙箱必须使用部署指定的固定内部地址。');
    this.#address = expected;
  }

  async run(input: RunInput, signal?: AbortSignal) {
    if (input.files.reduce((total, file) => total + file.bytes.byteLength, 0) > sandboxMaximumBytes)
      throw new AppError(
        413,
        'SANDBOX_INPUT_LIMIT',
        '输入文件合计超过 12 MiB，请减少文件后再运行。',
      );
    const timeout = AbortSignal.timeout((input.timeoutSeconds + 35) * 1000);
    try {
      const response = await fetch(new URL('run', this.#address), {
        method: 'POST',
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...input,
          files: input.files.map(({ name, bytes }) => ({
            name,
            bodyBase64: bytes.toString('base64'),
          })),
        }),
      });
      const raw = await readResponse(response);
      if (!response.ok) {
        const failure = errorShape.safeParse(raw);
        const code = failure.success ? failure.data.code : 'SANDBOX_RUN_FAILED';
        const message =
          code === 'SANDBOX_BUSY'
            ? '已有一个程序正在运行，请稍后重试。'
            : code === 'SANDBOX_SETUP_FAILED'
              ? '沙箱未能建立隔离，请联系维护人员检查内核与容器。'
              : '沙箱拒绝此次运行，请检查输入名称、大小及输出目录。';
        throw new AppError(response.status, code, message);
      }
      const result = sandboxResultSchema.safeParse(raw);
      if (
        !result.success ||
        result.data.codeSha256 !== checksum(input.code) ||
        result.data.inputHashes.length !== input.files.length ||
        (result.data.status !== 'ok' && result.data.files.length > 0)
      )
        throw invalid();
      for (const [index, file] of input.files.entries()) {
        const received = result.data.inputHashes[index];
        if (received?.name !== file.name || received.sha256 !== checksum(file.bytes))
          throw invalid();
      }
      const paths = new Set<string>();
      let used = 0;
      const files = result.data.files.map(({ bodyBase64, ...file }) => {
        used += file.byteSize;
        if (
          used > sandboxMaximumBytes ||
          paths.has(file.path) ||
          bodyBase64.length !== Math.ceil(file.byteSize / 3) * 4
        )
          throw invalid();
        const bytes = Buffer.from(bodyBase64, 'base64');
        if (bytes.byteLength !== file.byteSize || checksum(bytes) !== file.sha256) throw invalid();
        paths.add(file.path);
        return { ...file, bytes };
      });
      return { ...result.data, files };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, 'SANDBOX_UNAVAILABLE', '沙箱暂不可用，请检查本机沙箱服务再试。');
    }
  }
}
