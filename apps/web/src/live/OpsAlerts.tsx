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
      {data?.checkedAt && data.stale && (
        <p role="alert">最近三分钟未更新检查结果，请核对后台进程。</p>
      )}
      {data?.checkedAt && !data.stale && data.alerts.length === 0 && <p>没有活跃告警。</p>}
      {data && data.alerts.length > 0 && (
        <ul>
          {data.alerts.map((alert) => (
            <li key={alert.key}>
              <strong>{alert.level === 'critical' ? '严重' : '警告'}</strong>
              <span>{alert.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
