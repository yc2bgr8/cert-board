import type { Pool, PoolClient } from 'pg';

export async function raceOpsAbort<T>(task: Promise<T>, signal: AbortSignal) {
  let onAbort: () => void = () => undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([task, stopped]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export async function withOpsClient<T>(
  pool: Pool,
  signal: AbortSignal,
  work: (client: PoolClient) => Promise<T>,
) {
  signal.throwIfAborted();
  const pending = pool.connect();
  let client: PoolClient;
  try {
    client = await raceOpsAbort(pending, signal);
  } catch (error) {
    if (signal.aborted)
      void pending.then(
        (late) => late.release(true),
        () => undefined,
      );
    throw error;
  }
  let released = false;
  const destroy = () => {
    if (released) return;
    released = true;
    client.release(true);
  };
  signal.addEventListener('abort', destroy, { once: true });
  try {
    signal.throwIfAborted();
    return await raceOpsAbort(work(client), signal);
  } finally {
    signal.removeEventListener('abort', destroy);
    if (signal.aborted) destroy();
    if (!released) client.release();
  }
}
