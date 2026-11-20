export function enforceCostLimits(environment: string) {
  if (environment === 'development') return false;
  if (environment === 'test') return process.env.CERT_TEST_SHADOW_BUDGET === '1';
  return true;
}
