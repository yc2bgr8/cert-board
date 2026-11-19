import { fileURLToPath } from 'node:url';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { expect, test, vi } from 'vitest';
import { callCursorAcp, cursorPermissions } from './cursor-acp.js';

test('ACP 在数据库复核期间退出时确认未发送', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'cert-board-acp-test-'));
  const config = path.join(profile, 'cli-config.json');
  const mcp = path.join(profile, 'mcp.json');
  try {
    await Promise.all([
      writeFile(config, JSON.stringify(cursorPermissions)),
      writeFile(mcp, JSON.stringify({ mcpServers: {} })),
    ]);
    const beforeDispatch = vi.fn(async () => {
      await setTimeout(160);
    });
    const command = {
      executable: process.execPath,
      entrypoint: fileURLToPath(
        new URL('../test-support/cursor-acp-exit-fixture.mjs', import.meta.url),
      ),
      profileDirectory: profile,
      timeoutMs: 3000,
    };
    await expect(
      callCursorAcp(
        command,
        'gpt-flagship',
        {
          instructions: '合成握手验收',
          transcript: [],
        },
        beforeDispatch,
      ),
    ).rejects.toMatchObject({ confirmedNotSent: true });
    expect(beforeDispatch).toHaveBeenCalledOnce();
  } finally {
    await Promise.allSettled([unlink(config), unlink(mcp)]);
    await rmdir(profile);
  }
});
