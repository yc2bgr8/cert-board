import { fileURLToPath } from 'node:url';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { callCursorAcp, CursorAcpNativeToolError, cursorPermissions } from './cursor-acp.js';
import {
  cursorAcceptanceModels,
  CursorReplyFormatError,
  sendCursorAcceptance,
} from '../modelgw/cursor-acceptance.js';

test('正常结束的空回合是主 Agent 的格式错误，直接核实仍拒绝空回复', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'cert-board-acp-empty-test-'));
  const preferences = path.join(profile, 'cli-config.json');
  const mcp = path.join(profile, 'mcp.json');
  const marker = path.join(profile, 'empty-response-fixture');
  try {
    await Promise.all([
      writeFile(preferences, JSON.stringify(cursorPermissions)),
      writeFile(mcp, JSON.stringify({ mcpServers: {} })),
      writeFile(marker, ''),
    ]);
    const config = {
      executable: process.execPath,
      entrypoint: fileURLToPath(
        new URL('../test-support/cursor-acp-exit-fixture.mjs', import.meta.url),
      ),
      profileDirectory: profile,
      timeoutMs: 3000,
    };
    await expect(
      sendCursorAcceptance(config, cursorAcceptanceModels[0]!, {
        messages: [{ role: 'user', content: '合成验收' }],
      }),
    ).rejects.toBeInstanceOf(CursorReplyFormatError);
    await expect(
      callCursorAcp(
        config,
        'gpt-flagship',
        { instructions: '合成核实', transcript: [] },
        async () => {},
      ),
    ).rejects.toMatchObject({ code: 'failed', confirmedNotSent: false });
  } finally {
    await Promise.allSettled([unlink(preferences), unlink(mcp), unlink(marker)]);
    await rmdir(profile);
  }
});

test('Cursor 自身工具活动被阻断，不把已经派发的请求记成未发送', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'cert-board-acp-native-test-'));
  const config = path.join(profile, 'cli-config.json');
  const mcp = path.join(profile, 'mcp.json');
  try {
    await Promise.all([
      writeFile(config, JSON.stringify(cursorPermissions)),
      writeFile(mcp, JSON.stringify({ mcpServers: {} })),
    ]);
    const beforeDispatch = vi.fn(async () => undefined);
    const thrown = await callCursorAcp(
      {
        executable: process.execPath,
        entrypoint: fileURLToPath(
          new URL('../test-support/cursor-acp-exit-fixture.mjs', import.meta.url),
        ),
        profileDirectory: profile,
        timeoutMs: 3000,
      },
      'gpt-flagship',
      { instructions: '合成验收', transcript: [] },
      beforeDispatch,
    ).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(CursorAcpNativeToolError);
    expect(thrown).toMatchObject({ confirmedNotSent: false });
    expect(beforeDispatch).toHaveBeenCalledOnce();
  } finally {
    await Promise.allSettled([unlink(config), unlink(mcp)]);
    await rmdir(profile);
  }
});

test('ACP 临时目录创建失败时确认尚未发送', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'cert-board-acp-temp-test-'));
  const config = path.join(profile, 'cli-config.json');
  const mcp = path.join(profile, 'mcp.json');
  try {
    await Promise.all([
      writeFile(config, JSON.stringify(cursorPermissions)),
      writeFile(mcp, JSON.stringify({ mcpServers: {} })),
    ]);
    const missing = path.join(profile, 'missing-temp-directory');
    for (const key of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(key, missing);
    const beforeDispatch = vi.fn();
    await expect(
      callCursorAcp(
        { executable: process.execPath, entrypoint: config, profileDirectory: profile },
        'gpt-flagship',
        { instructions: '合成验收', transcript: [] },
        beforeDispatch,
      ),
    ).rejects.toMatchObject({ code: 'failed', confirmedNotSent: true });
    expect(beforeDispatch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
    await Promise.allSettled([unlink(config), unlink(mcp)]);
    await rmdir(profile);
  }
});

test('ACP 在数据库复核期间退出时确认未发送', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'cert-board-acp-test-'));
  const config = path.join(profile, 'cli-config.json');
  const mcp = path.join(profile, 'mcp.json');
  const trigger = path.join(profile, 'exit-fixture');
  try {
    await Promise.all([
      writeFile(config, JSON.stringify(cursorPermissions)),
      writeFile(mcp, JSON.stringify({ mcpServers: {} })),
    ]);
    const beforeDispatch = vi.fn(async (processClosed: AbortSignal) => {
      const closed = processClosed.aborted
        ? Promise.resolve()
        : new Promise<void>((resolve) =>
            processClosed.addEventListener('abort', () => resolve(), { once: true }),
          );
      await writeFile(trigger, '');
      await closed;
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
    await Promise.allSettled([unlink(config), unlink(mcp), unlink(trigger)]);
    await rmdir(profile);
  }
});
