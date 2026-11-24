import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  query: vi.fn(),
  closeDatabase: vi.fn(),
  closeTransport: vi.fn(),
  loadModels: vi.fn(),
  createQueue: vi.fn(),
  startDeadlines: vi.fn(),
  scanOps: vi.fn(),
  consume: vi.fn(),
  continuations: vi.fn(),
  lookupTicket: vi.fn(),
  enqueue: vi.fn(),
  stopQueue: vi.fn(),
  execute: vi.fn(),
  purge: vi.fn(),
  recover: vi.fn(),
  handoff: vi.fn(),
  finish: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  handler: undefined as
    undefined | ((runId: string, signal: AbortSignal, ticketId?: string) => Promise<void>),
}));
vi.mock('./logger.js', () => ({
  createLogger: () => ({ info: state.info, warn: state.warn, error: state.error }),
}));
vi.mock('./dependencies.js', () => ({
  createDependencies: () => ({
    database: { query: state.query },
    storage: {},
    close: state.closeDatabase,
  }),
}));
vi.mock('./modelgw/config.js', () => ({
  loadModelGatewayConfig: state.loadModels,
  parseAllowedModelHosts: () => ['openrouter.ai'],
}));
vi.mock('./modelgw/transport.js', () => ({
  createWorkerModelTransport: () => ({ close: state.closeTransport }),
}));
vi.mock('./modelgw/service.js', () => ({ ModelGateway: class {} }));
vi.mock('./agent/default-tools.js', () => ({ buildAgentTools: async () => [] }));
vi.mock('./agent/runtime.js', () => ({ executeAgentRun: state.execute }));
vi.mock('./deadlines/queue.js', () => ({ startDeadlineQueue: state.startDeadlines }));
vi.mock('./ops/service.js', () => ({ scanOpsAlerts: state.scanOps }));
vi.mock('./approvals/continuation.js', () => ({
  listContinuationsForDispatch: state.continuations,
  getContinuationTicket: state.lookupTicket,
}));
vi.mock('./budget/service.js', () => ({
  handoffBlockedBudgetRuns: state.handoff,
  markUsageIncomplete: async () => undefined,
}));
vi.mock('./runs/request-retention.js', () => ({ purgeExpiredModelRequests: state.purge }));
vi.mock('./queue/agent-queue.js', () => ({
  AGENT_QUEUE: 'cert-agent-runs',
  createAgentQueue: state.createQueue,
  consumeAgentRuns: state.consume,
  enqueueAgentRun: state.enqueue,
  finishAbandonedAgentRun: state.finish,
  recoverAbandonedAgentRuns: state.recover,
}));
import { startWorker } from './worker.js';

let worker: Awaited<ReturnType<typeof startWorker>> | undefined;

test('后台把批准后续跑送回同一运行，旧初始任务和不匹配票据不会重做任务', async () => {
  const runId = 'test-run';
  const ticketId = 'test-ticket';
  const otherTicketId = 'wrong-ticket';
  state.continuations.mockResolvedValue([{ runId, id: ticketId }]);
  state.query.mockImplementation(async (query: string) => ({
    rows: query.startsWith('SELECT status,lease_generation')
      ? [{ status: 'queued', lease_generation: '1' }]
      : [],
  }));
  state.lookupTicket.mockImplementation(async (_database, id: string) =>
    id === ticketId ? { runId, id, state: 'queued' } : { runId: 'other-run', id, state: 'queued' },
  );
  worker = await startWorker();
  expect(state.startDeadlines).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    expect.anything(),
  );
  expect(state.enqueue).toHaveBeenCalledExactlyOnceWith(expect.anything(), runId, ticketId);
  const { signal } = new AbortController();
  await state.handler!(runId, signal);
  await state.handler!(runId, signal, otherTicketId);
  expect(state.execute).not.toHaveBeenCalled();
  await state.handler!(runId, signal, ticketId);
  expect(state.execute).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    runId,
    expect.objectContaining({ ticketId }),
  );
});
beforeEach(() => {
  vi.clearAllMocks();
  state.handler = undefined;
  state.query.mockResolvedValue({ rows: [] });
  state.closeDatabase.mockResolvedValue(undefined);
  state.closeTransport.mockResolvedValue(undefined);
  state.loadModels.mockResolvedValue({ models: [] });
  state.stopQueue.mockResolvedValue(undefined);
  state.createQueue.mockResolvedValue({ stop: state.stopQueue });
  state.startDeadlines.mockResolvedValue(undefined);
  state.scanOps.mockResolvedValue([]);
  state.consume.mockImplementation(async (_boss, handler) => {
    state.handler = handler;
    return 'worker-fixture';
  });
  state.recover.mockResolvedValue({ stopped: 0, hasMore: false });
  state.handoff.mockResolvedValue(undefined);
  state.finish.mockResolvedValue(false);
  state.purge.mockResolvedValue({ deleted: 0 });
  state.execute.mockResolvedValue({ status: 'completed' });
  state.continuations.mockResolvedValue([]);
  state.lookupTicket.mockResolvedValue(null);
  state.enqueue.mockResolvedValue('test-job');
  for (const [key, value] of Object.entries({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1/daily',
    TEST_DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1/isolated_test',
    MINIO_ENDPOINT: '127.0.0.1',
    MINIO_ROOT_USER: 'fixture',
    MINIO_ROOT_PASSWORD: 'fixture-storage-only',
  }))
    vi.stubEnv(key, value);
});
afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

test('模型配置启动失败时关闭已经创建的数据库/存储资源', async () => {
  state.loadModels.mockRejectedValue(new Error('synthetic-config-failure'));
  await expect(startWorker()).rejects.toThrow('synthetic-config-failure');
  expect(state.closeDatabase).toHaveBeenCalledTimes(1);
  expect(state.createQueue).not.toHaveBeenCalled();
});

test('队列消费注册失败时清理队列、transport与依赖，不留下信号处理器', async () => {
  const original = process.listenerCount('SIGTERM');
  state.consume.mockRejectedValue(new Error('synthetic-worker-failure'));
  await expect(startWorker()).rejects.toThrow('synthetic-worker-failure');
  expect(state.stopQueue).toHaveBeenCalledTimes(1);
  expect(state.closeTransport).toHaveBeenCalledTimes(1);
  expect(state.closeDatabase).toHaveBeenCalledTimes(1);
  expect(process.listenerCount('SIGTERM')).toBe(original);
});

test('shutdown中止活动运行并等待其退出，然后才关闭transport和数据库', async () => {
  let finish!: () => void;
  const running = new Promise<void>((resolve) => {
    finish = resolve;
  });
  state.query.mockImplementation(async (sql: string) => ({
    rows: sql.startsWith('SELECT status,lease_generation')
      ? [{ status: 'queued', lease_generation: '0' }]
      : [],
  }));
  state.execute.mockImplementation(async () => {
    await running;
    return { status: 'stopped' };
  });
  worker = await startWorker();
  const task = state.handler!('10000000-0000-4000-8000-000000000001', new AbortController().signal);
  await vi.waitFor(() => expect(state.execute).toHaveBeenCalledTimes(1));
  const stopping = worker.stop();
  try {
    await Promise.resolve();
    await Promise.resolve();
    expect(state.execute.mock.calls[0]![2].signal.aborted).toBe(true);
    expect(state.closeDatabase).not.toHaveBeenCalled();
    expect(state.closeTransport).not.toHaveBeenCalled();
  } finally {
    finish();
    await task;
    await stopping;
  }
  expect(state.closeDatabase).toHaveBeenCalledTimes(1);
  expect(state.closeTransport).toHaveBeenCalledTimes(1);
  await worker.stop();
  expect(state.closeDatabase).toHaveBeenCalledTimes(1);
});

test('shutdown等待正在清理的维护事务，不与关库竞争', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  state.purge.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  worker = await startWorker();
  await vi.advanceTimersByTimeAsync(30000);
  expect(state.purge).toHaveBeenCalledTimes(1);
  const stopping = worker.stop();
  try {
    await Promise.resolve();
    await Promise.resolve();
    expect(state.closeDatabase).not.toHaveBeenCalled();
  } finally {
    finish();
    await stopping;
  }
  expect(state.closeDatabase).toHaveBeenCalledTimes(1);
});

test('启动阶段停止会等consumer注册结束，不让晚注册任务落入已关闭依赖', async () => {
  let finish!: () => void;
  const registering = new Promise<string>((resolve) => {
    finish = () => resolve('late-worker');
  });
  state.consume.mockReturnValue(registering);
  const before = new Set(process.listeners('SIGTERM'));
  const starting = startWorker();
  const result = starting.then(
    () => 'unexpected_success',
    (error: unknown) => (error as Error).message,
  );
  await vi.waitFor(() => expect(state.consume).toHaveBeenCalledTimes(1));
  const signal = process.listeners('SIGTERM').find((listener) => !before.has(listener));
  expect(Boolean(signal)).toBe(true);
  signal!('SIGTERM');
  try {
    await Promise.resolve();
    expect(state.stopQueue).not.toHaveBeenCalled();
    expect(state.closeDatabase).not.toHaveBeenCalled();
  } finally {
    finish();
  }
  expect(await result).toBe('WORKER_START_CANCELLED');
  expect(state.closeDatabase).toHaveBeenCalledTimes(1);
});
