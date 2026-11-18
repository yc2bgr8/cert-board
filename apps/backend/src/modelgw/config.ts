import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAlias, isNode, parseAllDocuments, visit } from 'yaml';
import { modelGatewayConfigSchema, type ModelGatewayConfig } from '@cert-board/shared';

export type {
  GatewayModelConfig,
  ModelGatewayConfig,
  RuntimeModelConfig,
} from '@cert-board/shared';

export class ModelConfigError extends Error {
  readonly code = 'MODEL_CONFIG_INVALID';
  constructor() {
    super('模型配置不可用，请检查模型设置、验收状态及精确出网白名单。');
    this.name = 'ModelConfigError';
  }
}

export function parseAllowedModelHosts(source: string): string[] {
  if (Buffer.byteLength(source, 'utf8') > 64000) throw new ModelConfigError();
  const hosts = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (
    !hosts.length ||
    hosts.length > 32 ||
    new Set(hosts).size !== hosts.length ||
    hosts.some((host) => !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host))
  )
    throw new ModelConfigError();
  return hosts;
}

export function parseModelGatewayConfig(
  source: string,
  allowedHosts: readonly string[],
  environment: string,
): ModelGatewayConfig {
  try {
    if (
      !['development', 'test', 'production'].includes(environment) ||
      Buffer.byteLength(source, 'utf8') > 64000
    )
      throw new ModelConfigError();
    const hosts = new Set(parseAllowedModelHosts(allowedHosts.join('\n')));
    const documents = parseAllDocuments(source, {
      version: '1.2',
      strict: true,
      uniqueKeys: true,
      stringKeys: true,
      prettyErrors: false,
      logLevel: 'silent',
      merge: false,
      resolveKnownTags: false,
    });
    const document = documents[0];
    if (documents.length !== 1 || !document) throw new ModelConfigError();
    if (document.errors.length || document.warnings.length) throw new ModelConfigError();
    visit(document, (_key, node) => {
      if (isAlias(node) || (isNode(node) && (('anchor' in node && node.anchor) || node.tag)))
        throw new ModelConfigError();
    });
    const config = modelGatewayConfigSchema.parse(document.toJS({ maxAliasCount: 0 }));
    for (const model of config.models) {
      const endpoint = new URL(model.baseUrl);
      if (
        !hosts.has(endpoint.hostname) ||
        (environment === 'production' && model.enabled && !model.accepted)
      )
        throw new ModelConfigError();
    }
    return config;
  } catch {
    // 原始 YAML 错误可能含凭据或正文，不能进入日志、对话或异常 cause。
    throw new ModelConfigError();
  }
}

export async function loadModelGatewayConfig(
  options: { configPath?: string; allowlistPath?: string; environment?: string } = {},
): Promise<ModelGatewayConfig> {
  try {
    const configPath =
      options.configPath ??
      fileURLToPath(new URL('../../../../deploy/models.yaml', import.meta.url));
    const allowlistPath =
      options.allowlistPath ??
      fileURLToPath(new URL('../../../../deploy/egress/allowlist', import.meta.url));
    const [source, allowlist] = await Promise.all([
      readFile(configPath, 'utf8'),
      readFile(allowlistPath, 'utf8'),
    ]);
    return parseModelGatewayConfig(
      source,
      parseAllowedModelHosts(allowlist),
      options.environment ?? process.env.NODE_ENV ?? 'production',
    );
  } catch {
    throw new ModelConfigError();
  }
}
