import pino, { type DestinationStream, type Logger } from 'pino';
import type { BackendConfig } from '@cert-board/shared';

const sensitiveField =
  /(?:authorization|cookie|set-cookie|password|passwd|(?:^|_)(?:key|token|secret)$|(?:csrf|session|access|refresh|id)Token$|(?:api|secret|access)Key$|database_url)/i;

export function sanitizeLogValue(value: unknown, secrets: readonly string[] = []): unknown {
  const seen = new WeakSet<object>();
  function clean(input: unknown, depth: number): unknown {
    if (typeof input === 'string') {
      let safe = input
        .replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]')
        .replace(/(?:postgres(?:ql)?|https?):\/\/[^\s/@]+:[^\s/@]+@/gi, '[已隐藏凭据]@');
      for (const secret of secrets) if (secret) safe = safe.replaceAll(secret, '[已隐藏]');
      return safe;
    }
    if (typeof input === 'bigint') return input.toString();
    if (input === null || typeof input !== 'object') return input;
    if (input instanceof Error) return { message: '错误详情已隐藏' };
    if (seen.has(input) || depth > 12) return '[已省略]';
    seen.add(input);
    if (Array.isArray(input)) return input.map((item) => clean(item, depth + 1));
    return Object.fromEntries(
      Object.entries(input).map(([key, entry]) => [
        key,
        sensitiveField.test(key) ? '[已隐藏]' : clean(entry, depth + 1),
      ]),
    );
  }
  return clean(value, 0);
}

export function createLogger(config: BackendConfig, destination?: DestinationStream): Logger {
  const secrets = Object.entries({ ...process.env, ...config })
    .filter(([key, value]) => sensitiveField.test(key) && typeof value === 'string')
    .map(([, value]) => String(value));
  for (const connection of [config.DATABASE_URL, config.TEST_DATABASE_URL]) {
    secrets.push(decodeURIComponent(new URL(connection).password));
  }
  const options: pino.LoggerOptions = {
    level: config.LOG_LEVEL,
    base: { service: 'cert-board' },
    formatters: {
      bindings: (bindings) => sanitizeLogValue(bindings, secrets) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        method.apply(this, args.map((arg) => sanitizeLogValue(arg, secrets)) as typeof args);
      },
    },
  };
  // Pino 子日志会重置 bindings formatter，因此在最终写出边界再检查一次。
  const safeDestination: DestinationStream = {
    write(line) {
      let output: string;
      try {
        output = JSON.stringify(sanitizeLogValue(JSON.parse(line), secrets)) + '\n';
      } catch {
        output = '{"level":40,"msg":"日志格式无效，内容已隐藏"}\n';
      }
      if (destination) destination.write(output);
      else process.stdout.write(output);
    },
  };
  return pino(options, safeDestination);
}
