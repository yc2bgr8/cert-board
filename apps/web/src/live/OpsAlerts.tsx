import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, errorMessage } from './api.js';
import { displayTime } from './WorkspacePages.js';

export function OpsAlerts({ userId }: { userId: string }) {
  const summary = useQuery({
    queryKey: ['live', 'ops-alerts', userId],
    queryFn: ({ signal }) => api.opsAlerts(signal),
    retry: false,
    refetchInterval: 30_000,
  });
  const data = summary.data;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, []);
  const stale =
    !!data?.checkedAt && (data.stale || now - Date.parse(data.checkedAt) >= 3 * 60 * 1000);
  return (
    <section className="live-page-message live-ops-alerts" aria-label="本机运维告警">
      {summary.isPending && <p role="status">正在读取本机运维告警…</p>}
      {summary.isError && (
        <p role="alert" className="live-error">
          {errorMessage(summary.error)}
        </p>
      )}
      {data?.checkedAt && (
        <p className="live-muted">最近检查 {displayTime(data.checkedAt)}（北京时间）</p>
      )}
      {data && !data.checkedAt && <p>等待后台首次检查。</p>}
      {stale && <p role="alert">最近三分钟未更新检查结果，请核对后台进程。</p>}
      {data?.checkedAt && !stale && !summary.isError && data.alerts.length === 0 && (
        <p>没有活跃告警。</p>
      )}
      {data && data.alerts.length > 0 && (
        <ul>
          {data.alerts.map((alert) => (
            <li key={alert.key}>
              <strong>{alert.level === 'critical' ? '严重' : '警告'}</strong>
              <span>
                {alert.detail}
                {(alert.lastSeenAt !== data.checkedAt || stale || summary.isError) && (
                  <small className="live-muted">
                    {' '}
                    上次确认 {displayTime(alert.lastSeenAt)} · 当前信号未验证
                  </small>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
