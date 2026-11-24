import { expect, test } from 'vitest';
import { gatewayFailureKind } from './failure.js';
import { evaluateOps, type OpsMeasurements } from './rules.js';

const gib = 1024n ** 3n;
const now = new Date('2030-01-08T09:00:00Z');
const healthy: OpsMeasurements = {
  services: {
    service_database: true,
    service_storage: true,
    service_docsvc: true,
    service_sandbox: true,
    service_fetcher: true,
  },
  deadlineLastSeenAt: new Date('2030-01-08T07:00:00.001Z'),
  queued: 19,
  queueSamples: 5,
  queueFailed: 0,
  wakeFailed: 0,
  gatewaySamples: 5,
  gatewayFailed: 0,
  gatewayTimeouts: 0,
  gatewayCredits: 0,
  monthly: { used: 79n, limit: 100n, percent: 80 },
  disk: { available: 10n * gib, total: 100n * gib },
  backup: 'completed',
};

test('每项本机告警按来源和阈值触发，恢复后可关闭', () => {
  expect(evaluateOps(healthy, now).filter(({ active }) => active)).toEqual([]);
  const limit: OpsMeasurements = {
    services: {
      service_database: false,
      service_storage: false,
      service_docsvc: false,
      service_sandbox: false,
      service_fetcher: false,
    },
    deadlineLastSeenAt: new Date('2030-01-08T07:00:00Z'),
    queued: 20,
    queueSamples: 5,
    queueFailed: 1,
    wakeFailed: 1,
    gatewaySamples: 5,
    gatewayFailed: 2,
    gatewayTimeouts: 1,
    gatewayCredits: 1,
    monthly: { used: 80n, limit: 100n, percent: 80 },
    disk: { available: 9n * gib, total: 100n * gib },
    backup: 'failed',
  };
  const active = evaluateOps(limit, now).filter(({ active }) => active === true);
  expect(active.map(({ key }) => key)).toEqual([
    'service_database',
    'service_storage',
    'service_docsvc',
    'service_sandbox',
    'service_fetcher',
    'deadline_stale',
    'queue_backlog',
    'queue_failures',
    'wake_failures',
    'gateway_errors',
    'gateway_timeout',
    'gateway_credit',
    'monthly_budget',
    'disk_low',
    'backup_failed',
  ]);
});

test('样本不足、来源缺失与用户取消使用不同处理', () => {
  const findings = evaluateOps(
    {
      ...healthy,
      queueSamples: 4,
      queueFailed: 4,
      gatewaySamples: 4,
      gatewayFailed: 4,
      gatewayTimeouts: 4,
      services: { ...healthy.services, service_docsvc: null },
      disk: null,
      backup: null,
      monthly: null,
    },
    now,
  );
  expect(findings.filter(({ active }) => active === true)).toEqual([]);
  expect(findings.filter(({ active }) => active === null).map(({ key }) => key)).toEqual([
    'service_docsvc',
    'monthly_budget',
    'disk_low',
    'backup_failed',
  ]);
  expect(gatewayFailureKind('MODEL_ABORTED', undefined, 'openrouter.ai')).toBeNull();
  expect(gatewayFailureKind('MODEL_TIMEOUT', undefined, 'openrouter.ai')).toBe('timeout');
  expect(gatewayFailureKind('MODEL_HTTP_ERROR', 402, 'openrouter.ai')).toBe('credits');
  expect(gatewayFailureKind('MODEL_HTTP_ERROR', 402, 'configured-local')).toBe('error');
});
