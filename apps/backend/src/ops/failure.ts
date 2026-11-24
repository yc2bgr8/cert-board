import type { Pool } from 'pg';
import { withOpsClient } from './bounded-client.js';

export function gatewayFailureKind(code: unknown, httpStatus: unknown, host: string) {
  if (code === 'MODEL_ABORTED') return null;
  if (httpStatus === 402 && host === 'openrouter.ai') return 'credits';
  if (code === 'MODEL_TIMEOUT') return 'timeout';
  return 'error';
}

export async function recordGatewayFailure(
  pool: Pool,
  requestKey: string,
  code: unknown,
  httpStatus: unknown,
  host: string,
) {
  const kind = gatewayFailureKind(code, httpStatus, host);
  if (!kind) return;
  await withOpsClient(pool, AbortSignal.timeout(1500), async (client) => {
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL lock_timeout='250ms'");
      await client.query(
        `INSERT INTO model_gateway_failure(request_key,kind)
          VALUES($1,$2) ON CONFLICT(request_key) DO NOTHING`,
        [requestKey, kind],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}
