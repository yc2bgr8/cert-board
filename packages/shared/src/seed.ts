import { z } from 'zod';

const developmentPasswordSchema = z
  .string()
  .min(16)
  .max(256)
  .refine((value) => value.trim().length > 0);

export const seedEnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test']),
  DEV_RA_PASSWORD: developmentPasswordSchema,
  DEV_RB_PASSWORD: developmentPasswordSchema,
  DEV_GM_PASSWORD: developmentPasswordSchema,
  DEV_SALES_PASSWORD: developmentPasswordSchema,
  DEV_TECH_PASSWORD: developmentPasswordSchema,
});

export class SeedConfigurationError extends Error {
  constructor(fields: string[]) {
    super(
      `开发种子配置无效：${[...new Set(fields)].join('、')}。仅允许 development/test；请在 .env.local 配置至少16字符的非空密码。`,
    );
    this.name = 'SeedConfigurationError';
  }
}

export function parseSeedEnvironment(environment: Record<string, unknown>) {
  const result = seedEnvironmentSchema.safeParse(environment);
  if (!result.success)
    throw new SeedConfigurationError(result.error.issues.map((issue) => String(issue.path[0])));
  return result.data;
}
