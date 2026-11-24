import { statfs } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import {
  docsvcBaseUrl,
  sandboxBaseUrl,
  opsAlertResponseSchema,
  type BackendConfig,
} from '@cert-board/shared';
import type { HealthDependencies } from '../dependencies.js';
import { raceOpsAbort, withOpsClient } from './bounded-client.js';
import { evaluateOps, type OpsFinding, type OpsMeasurements } from './rules.js';

const monitor = 'ops-monitor';
type Measurements = Omit<OpsMeasurements, 'services' | 'disk' | 'monthly'> & {
  used: string | null;
  limit: string | null;
  percent: number | null;
};

async function readMeasurements(
  pool: Pick<PoolClient, 'query'>,
  now: Date,
  environment: BackendConfig['NODE_ENV'],
) {
  const {
    rows: [sample],
  } = await pool.query<Measurements>(
    `WITH ranges AS (
        SELECT $1::timestamptz AS observed_at, $1::timestamptz-INTERVAL '1 hour' AS hour_start,
          $1::timestamptz-INTERVAL '24 hours' AS day_start,
          to_char($1::timestamptz AT TIME ZONE 'Asia/Shanghai','YYYY-MM') AS month_key
      ), queued AS (
        SELECT count(*) FILTER(WHERE status='queued')::int AS queued,
          count(*) FILTER(WHERE status IN ('completed','failed') AND updated_at>=hour_start AND updated_at<=observed_at)::int AS samples,
          count(*) FILTER(WHERE status='failed' AND updated_at>=hour_start AND updated_at<=observed_at)::int AS failures,
          count(*) FILTER(WHERE status='failed' AND trigger_type='wakeup' AND updated_at>=day_start AND updated_at<=observed_at)::int AS wakes
        FROM run,ranges WHERE trigger_type<>'evaluation' AND (status='queued' OR updated_at>=day_start)
      ), gateway AS (
        SELECT count(*) FILTER(WHERE l.updated_at>=r.hour_start AND l.updated_at<=r.observed_at
            AND l.status IN ('settled','unknown'))::int AS failures,
          count(*) FILTER(WHERE f.kind='timeout' AND l.updated_at>=r.hour_start
            AND l.updated_at<=r.observed_at AND l.status IN ('settled','unknown'))::int AS timeouts,
          count(*) FILTER(WHERE f.kind='credits' AND f.observed_at>=r.hour_start
            AND f.observed_at<=r.observed_at)::int AS credits
        FROM model_gateway_failure f JOIN usage_ledger l ON l.request_key=f.request_key
        CROSS JOIN ranges r WHERE l.updated_at>=r.hour_start OR f.observed_at>=r.hour_start
      ), policy AS (
        SELECT COALESCE((SELECT SUM(l.actual_nano) FROM usage_ledger l,ranges r
            WHERE l.policy_id=p.id AND l.month_key=r.month_key AND l.status='settled'
              AND l.updated_at<=r.observed_at),0)::text AS used,
          p.month_limit_nano::text AS limit_nano,p.alert_percent
        FROM budget_policy p WHERE p.id='default' AND p.environment=$2
      ) SELECT
        (SELECT last_seen_at FROM heartbeat WHERE service='deadline-scan') AS "deadlineLastSeenAt",
        q.queued,q.samples AS "queueSamples",q.failures AS "queueFailed",q.wakes AS "wakeFailed",
        (SELECT count(*)::int FROM usage_ledger,ranges
          WHERE updated_at>=hour_start AND updated_at<=observed_at AND status IN ('settled','unknown')) AS "gatewaySamples",
        g.failures AS "gatewayFailed",g.timeouts AS "gatewayTimeouts",g.credits AS "gatewayCredits",
        p.used,p.limit_nano AS "limit",p.alert_percent AS percent,
        (SELECT CASE WHEN action='backup.failed' THEN 'failed' ELSE 'completed' END
          FROM audit_log WHERE actor_kind='system' AND action IN ('backup.failed','backup.completed')
             AND created_at<=$1 ORDER BY created_at DESC,id DESC LIMIT 1) AS backup
      FROM queued q CROSS JOIN gateway g LEFT JOIN policy p ON true`,
    [now, environment],
  );
  return sample!;
}

async function reach(check: (() => Promise<unknown>) | undefined) {
  if (!check) return null;
  const timeout = AbortSignal.timeout(5_000);
  let abort: () => void = () => undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(check)
        .then(
          () => true,
          () => false,
        ),
      new Promise<boolean>((resolve) => {
        abort = () => resolve(false);
        timeout.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    timeout.removeEventListener('abort', abort);
  }
}
async function checkHttp(base: string, signal: AbortSignal) {
  const response = await fetch(new URL('health', base), {
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(4_000)]),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error('OPS_SERVICE_UNAVAILABLE');
}
async function diskSpace() {
  try {
    const values = await statfs(process.cwd(), { bigint: true });
    return { available: values.bavail * values.bsize, total: values.blocks * values.bsize };
  } catch {
    return null;
  }
}

export async function saveOpsFindings(
  pool: Pool,
  findings: OpsFinding[],
  now: Date,
  signal = AbortSignal.timeout(15_000),
) {
  return withOpsClient(pool, signal, async (tx) => {
    try {
      await tx.query('BEGIN');
      await tx.query("SET LOCAL lock_timeout='2s'");
      const heartbeat = await tx.query(
        `INSERT INTO heartbeat(service,last_seen_at) VALUES($1,$2)
        ON CONFLICT(service) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at
        WHERE heartbeat.last_seen_at<EXCLUDED.last_seen_at RETURNING service`,
        [monitor, now],
      );
      const opened: OpsFinding[] = [];
      if (heartbeat.rowCount) {
        const { rows: active } = await tx.query<{ key: string }>(
          'SELECT key FROM ops_alert WHERE resolved_at IS NULL',
        );
        const prior = new Set(active.map(({ key }) => key));
        for (const finding of findings) {
          if (finding.active === true) {
            await tx.query(
              `INSERT INTO ops_alert(key,level,detail,opened_at,last_seen_at) VALUES($1,$2,$3,$4,$4)
             ON CONFLICT(key) DO UPDATE SET level=EXCLUDED.level,detail=EXCLUDED.detail,
               opened_at=CASE WHEN ops_alert.resolved_at IS NULL THEN ops_alert.opened_at ELSE EXCLUDED.opened_at END,
               last_seen_at=EXCLUDED.last_seen_at,resolved_at=NULL`,
              [finding.key, finding.level, finding.detail, now],
            );
            if (!prior.has(finding.key)) opened.push(finding);
          } else if (finding.active === false && prior.has(finding.key)) {
            await tx.query(
              'UPDATE ops_alert SET resolved_at=$2 WHERE key=$1 AND resolved_at IS NULL',
              [finding.key, now],
            );
          }
        }
      }
      await tx.query('COMMIT');
      return opened;
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}

export async function scanOpsAlerts(
  pool: Pool,
  config: BackendConfig,
  health: HealthDependencies,
  fetcherConfigured: boolean,
  options: { now?: Date; signal?: AbortSignal; onDatabase?: (available: boolean) => void } = {},
) {
  const now = options.now ?? new Date();
  const duration = AbortSignal.timeout(15_000);
  const signal = options.signal ? AbortSignal.any([options.signal, duration]) : duration;
  signal.throwIfAborted();
  const fetcher =
    config.CONTAINER_RUNTIME === 'docker' ? 'http://fetch-relay:28084/' : 'http://127.0.0.1:28084/';
  const database = reach(() => health.checkDatabase()).then((available) => {
    if (available !== null && !signal.aborted) options.onDatabase?.(available);
    return available;
  });
  const [db, storage, docs, sandbox, web, disk] = await raceOpsAbort(
    Promise.all([
      database,
      reach(() => health.checkStorage()),
      reach(
        config.CERT_DOCSVC_URL
          ? () => checkHttp(docsvcBaseUrl(config.CONTAINER_RUNTIME), signal)
          : undefined,
      ),
      reach(
        config.CERT_SANDBOX_URL
          ? () => checkHttp(sandboxBaseUrl(config.CONTAINER_RUNTIME), signal)
          : undefined,
      ),
      reach(fetcherConfigured ? () => checkHttp(fetcher, signal) : undefined),
      diskSpace(),
    ]),
    signal,
  );
  const { used, limit, percent, ...sample } = await withOpsClient(pool, signal, (client) =>
    readMeasurements(client, now, config.NODE_ENV),
  );
  return saveOpsFindings(
    pool,
    evaluateOps(
      {
        ...sample,
        services: {
          service_database: db,
          service_storage: storage,
          service_docsvc: docs,
          service_sandbox: sandbox,
          service_fetcher: web,
        },
        disk,
        monthly:
          used !== null && limit !== null && percent !== null
            ? { used: BigInt(used), limit: BigInt(limit), percent }
            : null,
      },
      now,
    ),
    now,
    signal,
  );
}

export async function readOpsAlerts(tx: Pick<PoolClient, 'query'>) {
  const { rows } = await tx.query<{
    checked_at: Date;
    key: string | null;
    level: string | null;
    detail: string | null;
    opened_at: Date | null;
    last_seen_at: Date | null;
  }>(
    `SELECT h.last_seen_at AS checked_at,a.key,a.level,a.detail,a.opened_at,a.last_seen_at
      FROM heartbeat h LEFT JOIN LATERAL (
        SELECT key,level,detail,opened_at,last_seen_at
        FROM ops_alert WHERE resolved_at IS NULL
        ORDER BY (level='critical') DESC,last_seen_at DESC,key LIMIT 15
      ) a ON true WHERE h.service=$1
      ORDER BY (a.level='critical') DESC,a.last_seen_at DESC,a.key`,
    [monitor],
  );
  const checkedAt = rows[0]?.checked_at;
  return opsAlertResponseSchema.parse({
    checkedAt: checkedAt?.toISOString() ?? null,
    stale: !checkedAt || Date.now() - checkedAt.getTime() >= 3 * 60 * 1000,
    alerts: rows.flatMap((row) =>
      row.opened_at && row.last_seen_at
        ? [
            {
              key: row.key,
              level: row.level,
              detail: row.detail,
              openedAt: row.opened_at.toISOString(),
              lastSeenAt: row.last_seen_at.toISOString(),
            },
          ]
        : [],
    ),
  });
}
