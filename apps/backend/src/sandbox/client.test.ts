import { afterEach, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { SandboxClient } from './client.js';

afterEach(() => vi.unstubAllGlobals());

test('拒绝可变沙箱地址、响应哈希不符和不安全的临时文件', async () => {
  expect(() => new SandboxClient('http://example.invalid:28083', 'host')).toThrow();
  const run = new SandboxClient('http://127.0.0.1:28083', 'host');
  const validHash = createHash('sha256').update('print(1)').digest('hex');
  const response = {
    status: 'ok',
    exitCode: 0,
    elapsedMs: 7,
    codeSha256: 'a'.repeat(64),
    inputHashes: [],
    stdout: 'fixture',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    files: [],
  };
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json(response))
      .mockResolvedValueOnce(
        Response.json({
          ...response,
          codeSha256: validHash,
          files: [{ path: '../fixture.txt', byteSize: 0, sha256: 'b'.repeat(64), bodyBase64: '' }],
        }),
      ),
  );
  await expect(run.run({ code: 'print(1)', timeoutSeconds: 2, files: [] })).rejects.toMatchObject({
    statusCode: 502,
    code: 'SANDBOX_RESPONSE_INVALID',
  });
  await expect(run.run({ code: 'print(1)', timeoutSeconds: 2, files: [] })).rejects.toMatchObject({
    statusCode: 502,
    code: 'SANDBOX_RESPONSE_INVALID',
  });
});
