import type { OpsAlertKey, OpsAlertLevel } from '@cert-board/shared';

export const opsServiceLabels = {
  service_database: '数据库',
  service_storage: '文件存储',
  service_docsvc: '资料解析',
  service_sandbox: '代码沙箱',
  service_fetcher: '网页抓取',
};
export type OpsServiceKey = keyof typeof opsServiceLabels;
export type OpsMeasurements = {
  services: Record<OpsServiceKey, boolean | null>;
  deadlineLastSeenAt: Date | null;
  queued: number;
  queueSamples: number;
  queueFailed: number;
  wakeFailed: number;
  gatewaySamples: number;
  gatewayFailed: number;
  gatewayTimeouts: number;
  gatewayCredits: number;
  monthly: { used: bigint; limit: bigint; percent: number } | null;
  disk: { available: bigint; total: bigint } | null;
  backup: 'completed' | 'failed' | null;
};
export type OpsFinding = {
  key: OpsAlertKey;
  level: OpsAlertLevel;
  detail: string;
  active: boolean | null;
};
const gib = 1024n ** 3n;
const rateReached = (failed: number, total: number, percent: number) =>
  total >= 5 && failed * 100 >= total * percent;

export function evaluateOps(input: OpsMeasurements, now: Date): OpsFinding[] {
  const { monthly, disk } = input;
  const percentFree = disk && disk.total > 0n ? Number((disk.available * 100n) / disk.total) : null;
  return [
    ...(Object.keys(opsServiceLabels) as OpsServiceKey[]).map((key): OpsFinding => ({
      key,
      level: 'critical',
      active: input.services[key] === null ? null : !input.services[key],
      detail: `${opsServiceLabels[key]}不可用，请检查本机服务。`,
    })),
    {
      key: 'deadline_stale',
      level: 'critical',
      active:
        !input.deadlineLastSeenAt ||
        now.getTime() - input.deadlineLastSeenAt.getTime() >= 2 * 60 * 60 * 1000,
      detail: '最近两小时没有有效的定时器扫描心跳。',
    },
    {
      key: 'queue_backlog',
      level: 'warning',
      active: input.queued >= 20,
      detail: `当前有 ${input.queued} 个 Agent 运行等待派发。`,
    },
    {
      key: 'queue_failures',
      level: 'warning',
      active: rateReached(input.queueFailed, input.queueSamples, 20),
      detail: `最近一小时 ${input.queueSamples} 个已结束运行中有 ${input.queueFailed} 个失败。`,
    },
    {
      key: 'wake_failures',
      level: 'critical',
      active: input.wakeFailed > 0,
      detail: `最近 24 小时有 ${input.wakeFailed} 个唤醒运行失败。`,
    },
    {
      key: 'gateway_errors',
      level: 'warning',
      active: rateReached(input.gatewayFailed, input.gatewaySamples, 20),
      detail: `最近一小时 ${input.gatewaySamples} 笔模型请求中有 ${input.gatewayFailed} 笔上游失败。`,
    },
    {
      key: 'gateway_timeout',
      level: 'warning',
      active: rateReached(input.gatewayTimeouts, input.gatewaySamples, 10),
      detail: `最近一小时有 ${input.gatewayTimeouts} 笔模型请求超时。`,
    },
    {
      key: 'gateway_credit',
      level: 'critical',
      active: input.gatewayCredits > 0,
      detail: '最近一小时收到 OpenRouter 额度不足的回执。',
    },
    {
      key: 'monthly_budget',
      level: 'warning',
      active: monthly ? monthly.used * 100n >= monthly.limit * BigInt(monthly.percent) : null,
      detail: `本月结算费用已达到配置的 ${monthly?.percent ?? 0}% 告警阈值。`,
    },
    {
      key: 'disk_low',
      level: 'warning',
      active: disk && percentFree !== null ? disk.available < 5n * gib || percentFree < 10 : null,
      detail: `工作目录所在磁盘空间不足，剩余约 ${percentFree ?? 0}%。`,
    },
    {
      key: 'backup_failed',
      level: 'critical',
      active: input.backup === null ? null : input.backup === 'failed',
      detail: '最近一次已记录的备份失败，请核对本机备份记录。',
    },
  ];
}
