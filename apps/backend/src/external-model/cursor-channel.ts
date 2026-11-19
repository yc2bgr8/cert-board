import { spawn } from 'node:child_process';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  cursorCallStateSchema,
  VerificationChannelError,
  type VerificationPrompt,
} from './verification-runtime.js';

const systemEnvironment = new Set([
  'SYSTEMROOT',
  'WINDIR',
  'TEMP',
  'TMP',
  'PATH',
  'PATHEXT',
  'LANG',
]);
const maxOutputSize = 256 * 1024;
const answerTimeout = 5 * 60 * 1000;

export async function runCursorFixture(
  entrypoint: string,
  model: string,
  prompt: VerificationPrompt,
  timeoutMs = answerTimeout,
) {
  if (process.env.NODE_ENV !== 'test') throw new Error('VERIFICATION_FIXTURE_TEST_ONLY');
  const workdir = await mkdtemp(path.join(tmpdir(), 'cert-board-verification-'));
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => systemEnvironment.has(key.toUpperCase())),
    );
    return await new Promise<unknown>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--permission',
          `--allow-fs-read=${entrypoint}`,
          `--allow-fs-read=${workdir}`,
          entrypoint,
          model,
        ],
        {
          cwd: workdir,
          env,
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'ignore'],
        },
      );
      let bytes = 0;
      const pieces: Buffer[] = [];
      let failure: VerificationChannelError | null = null;
      function stop(error: VerificationChannelError) {
        failure ??= error;
        child.kill();
      }
      const timer = setTimeout(() => stop(new VerificationChannelError('timeout')), timeoutMs);
      child.stdin.on('error', () => undefined);
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxOutputSize) stop(new VerificationChannelError('failed'));
        else pieces.push(chunk);
      });
      child.once('error', (error: NodeJS.ErrnoException) => {
        failure ??= new VerificationChannelError(
          error.code === 'ENOENT' ? 'not_installed' : 'failed',
        );
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (failure) return reject(failure);
        if (code !== 0) return reject(new VerificationChannelError('failed'));
        try {
          const response: unknown = JSON.parse(Buffer.concat(pieces).toString('utf8'));
          const state = cursorCallStateSchema.safeParse(
            response && typeof response === 'object' && 'error' in response
              ? response.error
              : undefined,
          );
          if (state.success) return reject(new VerificationChannelError(state.data));
          resolve(response);
        } catch {
          reject(new VerificationChannelError('failed'));
        }
      });
      child.stdin.end(JSON.stringify(prompt));
    });
  } finally {
    // mkdtemp 建立的独立目录正常调用保持为空。
    await rmdir(workdir);
  }
}
