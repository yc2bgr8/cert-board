import { z } from 'zod';

const databaseUrl = z
  .string()
  .url()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    try {
      decodeURIComponent(url.password);
      return (
        ['postgres:', 'postgresql:'].includes(url.protocol) &&
        decodeURIComponent(url.pathname).length > 1
      );
    } catch {
      return false;
    }
  });

export const backendConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.literal('127.0.0.1').default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1024).max(65535).default(28081),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),
    WEB_ORIGIN: z
      .enum([
        'http://127.0.0.1:28080',
        'http://localhost:28080',
        'https://127.0.0.1:28080',
        'https://localhost:28080',
      ])
      .default('http://127.0.0.1:28080'),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24).default(12),
    DATABASE_URL: databaseUrl,
    TEST_DATABASE_URL: databaseUrl,
    MINIO_ENDPOINT: z
      .string()
      .min(1)
      .refine((value) => !value.includes('://') && !value.includes('/')),
    MINIO_PORT: z.coerce.number().int().min(1).max(65535).default(29000),
    MINIO_USE_SSL: z.preprocess(
      (value) => (value === 'true' ? true : value === 'false' ? false : value),
      z.boolean().default(false),
    ),
    MINIO_ROOT_USER: z.string().min(3),
    MINIO_ROOT_PASSWORD: z.string().min(16),
    MINIO_BUCKET: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
      .default('cert-board'),
  })
  .superRefine((config, context) => {
    if (config.NODE_ENV === 'production' && !config.WEB_ORIGIN.startsWith('https://')) {
      context.addIssue({ code: 'custom', path: ['WEB_ORIGIN'], message: '生产环境必须使用HTTPS' });
    }
    if (!URL.canParse(config.DATABASE_URL) || !URL.canParse(config.TEST_DATABASE_URL)) return;
    const primary = new URL(config.DATABASE_URL);
    const test = new URL(config.TEST_DATABASE_URL);
    let primaryName: string;
    let testName: string;
    try {
      primaryName = decodeURIComponent(primary.pathname);
      testName = decodeURIComponent(test.pathname);
    } catch {
      return;
    }
    if (primaryName === testName) {
      context.addIssue({
        code: 'custom',
        path: ['TEST_DATABASE_URL'],
        message: '测试数据库必须与日常数据库分离',
      });
    }
    if (!testName.endsWith('_test')) {
      context.addIssue({
        code: 'custom',
        path: ['TEST_DATABASE_URL'],
        message: '测试数据库名称必须以_test结尾',
      });
    }
  });

export type BackendConfig = z.infer<typeof backendConfigSchema>;

export class ConfigurationError extends Error {
  constructor(fields: string[]) {
    super(
      `配置缺失或无效：${[...new Set(fields)].join('、')}。请在 .env.local 中修正这些变量，再重新启动。`,
    );
    this.name = 'ConfigurationError';
  }
}

export function parseBackendConfig(environment: Record<string, unknown>): BackendConfig {
  const result = backendConfigSchema.safeParse(environment);
  if (!result.success)
    throw new ConfigurationError(result.error.issues.map((issue) => String(issue.path[0])));
  return result.data;
}

export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string().max(512), requestId: z.string() }),
});

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  dependencies: z.object({ database: z.enum(['up', 'down']), storage: z.enum(['up', 'down']) }),
});
