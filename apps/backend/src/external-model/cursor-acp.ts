import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual, promisify } from 'node:util';
import { z } from 'zod';
import { VerificationChannelError, type VerificationPrompt } from './verification-runtime.js';

export const cursorModels = {
  'gpt-flagship': 'gpt-5.6-sol[context=272k,reasoning=medium,fast=false]',
  'claude-flagship': 'claude-opus-5-5[context=300k,effort=medium,fast=false]',
} as const;

export const cursorPermissions = {
  version: 1,
  editor: { vimMode: false },
  permissions: {
    allow: [],
    deny: ['Read(**)', 'Write(**)', 'Shell(*)', 'Mcp(*:*)', 'WebFetch(*)'],
  },
  sandbox: { mode: 'enabled', readBoundary: 'workspace' },
};
const noMcpServers = { mcpServers: {} };
const maxProtocolBytes = 1024 * 1024;
const maxReplyLength = 24000;
const execute = promisify(execFile);
const systemEnvironment =
  /^(SystemRoot|WINDIR|COMSPEC|PATH|PATHEXT|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|LANG)$/iu;
const object = z.record(z.string(), z.unknown());
const frame = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.number().int(), z.string(), z.null()]).optional(),
    method: z.string().optional(),
    params: object.optional(),
    result: z.unknown().optional(),
    error: z.object({ code: z.number(), message: z.string() }).passthrough().optional(),
  })
  .passthrough();
const configOptions = z.object({
  configOptions: z.array(
    z.object({ id: z.string(), category: z.string().optional(), currentValue: z.unknown() }),
  ),
});
const sessionSetup = configOptions.extend({ sessionId: z.string().min(1) });
const textChunk = z.object({ type: z.literal('text'), text: z.string() });

export type CursorAcpConfig = {
  executable: string;
  entrypoint: string;
  profileDirectory: string;
  timeoutMs?: number;
};

async function verifiedProfile(directory: string) {
  try {
    const [config, mcp, entries] = await Promise.all([
      readFile(path.join(directory, 'cli-config.json'), 'utf8'),
      readFile(path.join(directory, 'mcp.json'), 'utf8'),
      readdir(directory),
    ]);
    const parsed = object.parse(JSON.parse(config));
    const excluded = ['sandbox.json', 'rules', 'skills', 'plugins', 'agents', 'hooks'];
    // CLI 可缓存模型选择与认证元数据。每次派发重新核对能放宽权限的配置。
    if (
      parsed.version !== cursorPermissions.version ||
      !isDeepStrictEqual(parsed.permissions, cursorPermissions.permissions) ||
      !isDeepStrictEqual(parsed.sandbox, cursorPermissions.sandbox) ||
      parsed.autoAcceptWebSearch === true ||
      !isDeepStrictEqual(JSON.parse(mcp), noMcpServers) ||
      entries.some((entry) => excluded.includes(entry.toLowerCase()))
    )
      throw new Error('profile');
  } catch {
    throw new VerificationChannelError('privacy_unverified');
  }
}

function failure(message: string) {
  if (/not (?:signed|logged) in|not authenticated|login required|unauthenticated/iu.test(message))
    return new VerificationChannelError('not_signed_in');
  if (/quota|rate limit|usage limit|payment required/iu.test(message))
    return new VerificationChannelError('quota');
  return new VerificationChannelError('failed');
}

function allowedOption(value: unknown, category: string, expected: string) {
  const { configOptions: options } = configOptions.parse(value);
  return options.some((option) => option.category === category && option.currentValue === expected);
}

function cursorEnvironment(profile: string) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => systemEnvironment.test(key)),
    ),
    CURSOR_CONFIG_DIR: profile,
  };
}

export async function checkCursorAccount(config: CursorAcpConfig) {
  await verifiedProfile(config.profileDirectory);
  try {
    const { stdout } = await execute(config.executable, [config.entrypoint, 'status'], {
      cwd: tmpdir(),
      env: cursorEnvironment(config.profileDirectory),
      windowsHide: true,
      shell: false,
      timeout: 15000,
      maxBuffer: 65536,
    });
    if (!/logged in as|signed in as|authenticated as/iu.test(stdout))
      throw new VerificationChannelError('not_signed_in');
  } catch (error) {
    if (error instanceof VerificationChannelError) throw error;
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    if (code === 'ENOENT') throw new VerificationChannelError('not_installed');
    throw new VerificationChannelError('failed');
  }
}

export async function callCursorAcp(
  config: CursorAcpConfig,
  modelId: string,
  prompt: VerificationPrompt,
) {
  const model = cursorModels[modelId as keyof typeof cursorModels];
  if (typeof model !== 'string') throw new VerificationChannelError('failed');
  if (
    !path.isAbsolute(config.executable) ||
    !path.isAbsolute(config.entrypoint) ||
    !path.isAbsolute(config.profileDirectory)
  )
    throw new VerificationChannelError('not_installed');
  await verifiedProfile(config.profileDirectory);
  const workspace = await mkdtemp(path.join(tmpdir(), 'cert-board-cursor-'));
  const child = spawn(config.executable, [config.entrypoint, '--sandbox', 'enabled', 'acp'], {
    cwd: workspace,
    env: cursorEnvironment(config.profileDirectory),
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const lines = createInterface({ input: child.stdout });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const waits = new Map<number, { resolve(value: unknown): void; reject(reason: Error): void }>();
  let sequence = 0;
  let answer = '';
  let size = 0;
  let error: VerificationChannelError | null = null;
  let sessionId: string | null = null;
  function abort(reason: VerificationChannelError) {
    error ??= reason;
    for (const waiter of waits.values()) waiter.reject(error);
    waits.clear();
  }
  const timer = setTimeout(
    () => abort(new VerificationChannelError('timeout')),
    config.timeoutMs ?? 300000,
  );
  function write(packet: Record<string, unknown>) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...packet }) + '\n');
  }
  function rpc(method: string, params: Record<string, unknown>) {
    const id = ++sequence;
    return new Promise<unknown>((resolve, reject) => {
      if (error) return reject(error);
      waits.set(id, { resolve, reject });
      write({ id, method, params });
    });
  }
  child.stdin.on('error', () => abort(new VerificationChannelError('failed')));
  child.on('error', (cause: NodeJS.ErrnoException) =>
    abort(new VerificationChannelError(cause.code === 'ENOENT' ? 'not_installed' : 'failed')),
  );
  child.on('exit', () => abort(new VerificationChannelError('failed')));
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > maxProtocolBytes) abort(new VerificationChannelError('failed'));
  });
  lines.on('line', (line) => {
    if (error) return;
    try {
      const packet = frame.parse(JSON.parse(line));
      if (!packet.method && typeof packet.id === 'number') {
        const waiting = waits.get(packet.id);
        waits.delete(packet.id);
        if (packet.error) waiting?.reject(failure(packet.error.message));
        else waiting?.resolve(packet.result);
      } else if (packet.method && packet.id !== undefined) {
        if (packet.method === 'session/request_permission')
          write({ id: packet.id, result: { outcome: { outcome: 'cancelled' } } });
        else write({ id: packet.id, error: { code: -32601, message: 'Unavailable' } });
        abort(new VerificationChannelError('failed'));
      } else if (packet.method === 'session/update' && packet.params?.sessionId === sessionId) {
        const update = object.parse(packet.params.update);
        if (update.sessionUpdate === 'agent_message_chunk') {
          const content = textChunk.safeParse(update.content);
          if (content.success) answer += content.data.text;
          if (answer.length > maxReplyLength) abort(new VerificationChannelError('failed'));
        } else if (
          update.sessionUpdate === 'tool_call' ||
          update.sessionUpdate === 'tool_call_update'
        ) {
          abort(new VerificationChannelError('failed'));
        }
      }
    } catch {
      abort(new VerificationChannelError('failed'));
    }
  });

  try {
    const init = await rpc('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'cert-board', version: '0.1.0' },
    });
    if (!z.object({ protocolVersion: z.literal(1) }).safeParse(init).success)
      throw new VerificationChannelError('failed');
    const ready = sessionSetup.parse(await rpc('session/new', { cwd: workspace, mcpServers: [] }));
    sessionId = ready.sessionId;
    const choice = await rpc('session/set_config_option', {
      sessionId,
      configId: 'mode',
      value: 'ask',
    });
    if (!allowedOption(choice, 'mode', 'ask')) throw new VerificationChannelError('failed');
    const configured = await rpc('session/set_config_option', {
      sessionId,
      configId: 'model',
      value: model,
    });
    if (!allowedOption(configured, 'model', model)) throw new VerificationChannelError('failed');
    const completed = await rpc('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: JSON.stringify(prompt) }],
    });
    if (error) throw error;
    if (
      !z.object({ stopReason: z.literal('end_turn') }).safeParse(completed).success ||
      !answer.trim()
    )
      throw new VerificationChannelError('failed');
    const reply = answer
      .trim()
      .replace(/^\x60\x60\x60(?:json)?\s*/iu, '')
      .replace(/\s*\x60\x60\x60$/u, '');
    try {
      return { ...object.parse(JSON.parse(reply)), providerText: answer };
    } catch {
      return { text: answer, claims: [], providerText: answer };
    }
  } catch (cause) {
    if (cause instanceof VerificationChannelError) throw cause;
    throw new VerificationChannelError('failed');
  } finally {
    clearTimeout(timer);
    if (sessionId && error && !child.stdin.destroyed)
      write({ method: 'session/cancel', params: { sessionId } });
    child.stdin.end();
    child.kill();
    lines.close();
    await closed;
    if (!(await readdir(workspace)).length) await rmdir(workspace).catch(() => undefined);
  }
}
