import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAlias, isNode, parseAllDocuments, visit } from 'yaml';
import {
  modelGatewayConfigSchema,
  selectGatewayModel,
  type ModelGatewayConfig,
} from '@cert-board/shared';

export type {
  GatewayModelConfig,
  ModelGatewayConfig,
  RuntimeModelConfig,
} from '@cert-board/shared';

export class ModelConfigError extends Error {
  readonly code = 'MODEL_CONFIG_INVALID';
  constructor(readonly missingFile = false) {
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
  overrides: { localEndpoint?: string; developmentModel?: string } = {},
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
    const parsed = modelGatewayConfigSchema.parse(document.toJS({ maxAliasCount: 0 }));
    const localEndpoint = overrides.localEndpoint?.trim();
    if (localEndpoint && parsed.models.filter((model) => model.transport === 'local').length !== 1)
      throw new ModelConfigError();
    const developmentDefault =
      environment === 'development'
        ? overrides.developmentModel?.trim() || parsed.developmentDefault
        : undefined;
    const config = modelGatewayConfigSchema.parse({
      version: parsed.version,
      models: parsed.models
        .filter(
          (model) =>
            environment !== 'production' || model.transport === 'local' || !model.developmentOnly,
        )
        .map((model) =>
          model.transport === 'local' && localEndpoint
            ? { ...model, baseUrl: localEndpoint }
            : model,
        ),
      ...(developmentDefault ? { developmentDefault } : {}),
    });
    if (
      developmentDefault &&
      !config.models.some(
        (model) => model.transport !== 'local' && model.enabled && model.id === developmentDefault,
      )
    )
      throw new ModelConfigError();
    for (const model of config.models) {
      if (
        (model.transport !== 'local' && !hosts.has(new URL(model.baseUrl).hostname)) ||
        (environment === 'production' && model.enabled && model.baseUrl !== null && !model.accepted)
      )
        throw new ModelConfigError();
    }
    return config;
  } catch {
    // 原始 YAML 错误可能含凭据或正文，不能进入日志、对话或异常 cause。
    throw new ModelConfigError();
  }
}

type ModelConfigLoadOptions = {
  configPath?: string;
  allowlistPath?: string;
  environment?: string;
  sourceEnv?: NodeJS.ProcessEnv;
};

export async function loadModelGatewayConfig(
  options: ModelConfigLoadOptions = {},
): Promise<ModelGatewayConfig> {
  try {
    const configPath =
      options.configPath ??
      fileURLToPath(new URL('../../../../deploy/models.yaml', import.meta.url));
    const allowlistPath =
      options.allowlistPath ??
      fileURLToPath(new URL('../../../../deploy/egress/allowlist', import.meta.url));
    const source = await readFile(configPath, 'utf8').catch((error: unknown) => {
      const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
      throw new ModelConfigError(missing);
    });
    const allowlist = await readFile(allowlistPath, 'utf8');
    const environment = options.environment ?? process.env.NODE_ENV ?? 'production';
    const sourceEnv = options.sourceEnv ?? (environment === 'test' ? {} : process.env);
    const localEndpoint = sourceEnv.CERT_LOCAL_MODEL_BASE_URL;
    const developmentModel = sourceEnv.CERT_DEV_MODEL_ID;
    return parseModelGatewayConfig(source, parseAllowedModelHosts(allowlist), environment, {
      ...(localEndpoint ? { localEndpoint } : {}),
      ...(developmentModel ? { developmentModel } : {}),
    });
  } catch (error) {
    if (error instanceof ModelConfigError) throw error;
    throw new ModelConfigError();
  }
}

export async function loadVerificationModelGatewayConfig(options: ModelConfigLoadOptions = {}) {
  const sourceEnv = options.sourceEnv ?? process.env;
  const explicitlyConfigured =
    sourceEnv.CERT_LOCAL_MODEL_BASE_URL?.trim() ||
    (sourceEnv.HTTPS_PROXY && sourceEnv.OPENROUTER_API_KEY);
  const models = await loadModelGatewayConfig({ ...options, sourceEnv }).catch((error: unknown) => {
    if (!explicitlyConfigured && error instanceof ModelConfigError && error.missingFile)
      return undefined;
    throw error;
  });
  return models &&
    (explicitlyConfigured || selectGatewayModel(models, 'agent')?.transport === 'local')
    ? models
    : undefined;
}
