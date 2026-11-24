import type { Pool } from 'pg';

export function gatewayFailureKind(code: unknown, httpStatus: unknown, host: string) {
  if (code === 'MODEL_ABORTED') return null;
  if (httpStatus === 402 && host === 'openrouter.ai') return 'credits';
  if (code === 'MODEL_TIMEOUT') return 'timeout';
  return 'error';
}

export async function recordGatewayFailure(
  pool: Pick<Pool, 'query'>,
  requestKey: string,
  code: unknown,
  httpStatus: unknown,
  host: string,
) {
  const kind = gatewayFailureKind(code, httpStatus, host);
  if (!kind) return;
  await pool.query(
    `INSERT INTO model_gateway_failure(request_key,kind)
      VALUES($1,$2) ON CONFLICT(request_key) DO NOTHING`,
    [requestKey, kind],
  );
}
