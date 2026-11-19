import { readFileSync } from 'node:fs';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { selectGatewayModel } from '@cert-board/shared';
import {
  ModelConfigError,
  loadModelGatewayConfig,
  loadVerificationModelGatewayConfig,
  parseAllowedModelHosts,
  parseModelGatewayConfig,
} from './config.js';

const source = readFileSync(new URL('../../../../deploy/models.yaml', import.meta.url), 'utf8');
const hosts = ['openrouter.ai'];
describe('唯一YAML模型配置来源', () => {
  it('读出精确模型、价格、提供方和用途，不包含密钥值', () => {
    const config = parseModelGatewayConfig(source, hosts, 'test');
    expect(config.models).toHaveLength(3);
    const qwen = config.models.find(({ id }) => id === 'qwen-flash');
    expect(qwen).toMatchObject({
      id: 'qwen-flash',
      upstreamModel: 'qwen/qwen3.8-flash',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      accepted: false,
      maxDataLevel: 'internal',
      reasoning: { enabled: false },
      prices: {
        inputUsdPerMillion: '0.15',
        cacheReadUsdPerMillion: '0.016',
        outputUsdPerMillion: '0.47',
      },
      provider: { only: ['alibaba/us-east-1'], allow_fallbacks: false, require_parameters: true },
    });
    expect(qwen).not.toHaveProperty('apiKey');
    expect(() => parseModelGatewayConfig(source, hosts, 'production')).toThrow(ModelConfigError);
    expect(
      parseModelGatewayConfig(
        source.replaceAll('accepted: false', 'accepted: true'),
        hosts,
        'production',
      ).models[0]?.accepted,
    ).toBe(true);
  });

  it('开发默认使用同代模拟模型，可切换 Qwen，配置本地内网端点后优先路由', () => {
    const development = parseModelGatewayConfig(source, hosts, 'development');
    expect(development.models[0]).toMatchObject({
      transport: 'local',
      baseUrl: null,
      maxDataLevel: 'confidential',
    });
    expect(selectGatewayModel(development, 'agent')).toMatchObject({
      id: 'deepseek-flash-1017',
      provider: { only: ['deepinfra/fp8'], zdr: true, data_collection: 'deny' },
    });
    const switched = parseModelGatewayConfig(source, hosts, 'development', {
      developmentModel: 'qwen-flash',
    });
    expect(selectGatewayModel(switched, 'agent')?.id).toBe('qwen-flash');
    const local = parseModelGatewayConfig(source, hosts, 'development', {
      localEndpoint: 'http://192.168.2.12:8081/v1',
    });
    expect(selectGatewayModel(local, 'agent')?.id).toBe('deepseek-local');
    expect(() =>
      parseModelGatewayConfig(source, hosts, 'development', { developmentModel: 'unknown-model' }),
    ).toThrow(ModelConfigError);
  });

  it('本地模型拒绝公网、DNS 名称、保留地址、URL 凭据和非兼容基路径', () => {
    for (const localEndpoint of [
      'https://openrouter.ai/v1',
      'http://8.8.8.8/v1',
      'http://198.18.0.1/v1',
      'http://user:secret@127.0.0.1/v1',
      'http://127.0.0.1/admin',
      'http://127.0.0.1/v1?key=fixture',
    ]) {
      expect(() =>
        parseModelGatewayConfig(source, hosts, 'development', { localEndpoint }),
      ).toThrow(ModelConfigError);
    }
    expect(() =>
      parseModelGatewayConfig(
        source.replace("outputUsdPerMillion: '0'", "outputUsdPerMillion: '1'"),
        hosts,
        'development',
      ),
    ).toThrow(ModelConfigError);
  });

  it('生产沿用已批准的 Qwen，开发模拟模型不参与选路或生产批准检查', () => {
    const sourceConfig = parseModelGatewayConfig(source, hosts, 'development');
    const production = parseModelGatewayConfig(
      JSON.stringify({
        ...sourceConfig,
        models: sourceConfig.models.map((model) => ({
          ...model,
          accepted: model.id === 'qwen-flash',
        })),
      }),
      hosts,
      'production',
    );
    expect(production.models.map(({ id }) => id)).toEqual(['deepseek-local', 'qwen-flash']);
    expect(selectGatewayModel(production, 'agent')?.id).toBe('qwen-flash');
    expect(production).not.toHaveProperty('developmentDefault');
  });

  it('只使用 Cursor 的宿主进程在模型配置缺失时继续使用程序主持', async () => {
    const configPath = 'nonexistent-model-config-fixture';
    await expect(
      loadVerificationModelGatewayConfig({ configPath, environment: 'development', sourceEnv: {} }),
    ).resolves.toBeUndefined();
    await expect(
      loadVerificationModelGatewayConfig({
        configPath,
        environment: 'development',
        sourceEnv: { CERT_LOCAL_MODEL_BASE_URL: 'http://127.0.0.1:3001/v1' },
      }),
    ).rejects.toBeInstanceOf(ModelConfigError);
  });

  it('核实主持识别只在 YAML 中设置的本地模型地址', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cert-board-local-model-'));
    const configPath = join(directory, 'models.yaml');
    try {
      await writeFile(
        configPath,
        source.replace('baseUrl: null', 'baseUrl: http://127.0.0.1:6451/v1'),
        'utf8',
      );
      const config = await loadVerificationModelGatewayConfig({
        configPath,
        environment: 'development',
        sourceEnv: {},
      });
      expect(config && selectGatewayModel(config, 'agent')?.id).toBe('deepseek-local');
      await writeFile(configPath, source.replace('version: 1', 'version: 1\nversion: 1'), 'utf8');
      await expect(
        loadVerificationModelGatewayConfig({
          configPath,
          environment: 'development',
          sourceEnv: {},
        }),
      ).rejects.toMatchObject({ code: 'MODEL_CONFIG_INVALID', missingFile: false });
    } finally {
      await unlink(configPath).catch(() => undefined);
      await rmdir(directory);
    }
  });
  it('拒绝重复键、别名、锚点、标签、多文档及未知字段', () => {
    for (const invalid of [
      source.replace('version: 1', 'version: 1\nversion: 1'),
      source.replace('family: qwen', 'family: &family qwen'),
      source
        .replace('family: qwen', 'family: &family qwen')
        .replace('upstreamModel: qwen/qwen3.8-flash', 'upstreamModel: *family'),
      source.replace('family: qwen', 'family: !env private'),
      source + '\n---\nversion: 1\nmodels: []\n',
      source.replace('family: qwen', 'family: qwen\n    apiKey: synthetic-config-secret'),
      source.replace("inputUsdPerMillion: '0.15'", 'inputUsdPerMillion: 0.15'),
    ])
      expect(() => parseModelGatewayConfig(invalid, hosts, 'test')).toThrow(ModelConfigError);
  });
  it('精确匹配允许主机，拒绝凭据、非HTTPS、查询参数和伪装主机', () => {
    for (const url of [
      'http://openrouter.ai/api/v1',
      'https://openrouter.ai.evil.test/api/v1',
      'https://openrouter.ai@evil.test/api/v1',
      'https://user:password@openrouter.ai/api/v1',
      'https://openrouter.ai:8443/api/v1',
      'https://openrouter.ai/api/v1?key=fixture',
      'https://127.0.0.1/api/v1',
    ]) {
      expect(() =>
        parseModelGatewayConfig(source.replace('https://openrouter.ai/api/v1', url), hosts, 'test'),
      ).toThrow(ModelConfigError);
    }
    for (const allowlist of [
      '',
      '.openrouter.ai',
      '*.openrouter.ai',
      'openrouter.ai:443',
      'openrouter.ai\nopenrouter.ai',
    ])
      expect(() => parseAllowedModelHosts(allowlist)).toThrow(ModelConfigError);
    expect(parseAllowedModelHosts('# 精确主机\nopenrouter.ai\n')).toEqual(hosts);
  });
  it('拒绝模型重复或通过配置放宽保密路由、回退与推理限制', () => {
    const config = parseModelGatewayConfig(source, hosts, 'test');
    expect(() =>
      parseModelGatewayConfig(
        JSON.stringify({ ...config, models: [config.models[0], config.models[0]] }),
        hosts,
        'test',
      ),
    ).toThrow(ModelConfigError);
    for (const changed of [
      source.replace('maxDataLevel: internal', 'maxDataLevel: confidential'),
      source.replace('allow_fallbacks: false', 'allow_fallbacks: true'),
      source.replace('enabled: false', 'enabled: true'),
      source.replace('supportsImages: false', 'supportsImages: true'),
    ])
      expect(() => parseModelGatewayConfig(changed, hosts, 'test')).toThrow(ModelConfigError);
  });
  it('错误不回显原始YAML、凭据或解析警告，文件读取失败也只返回固定信息', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      let thrown: unknown;
      try {
        parseModelGatewayConfig('secret: [synthetic-private-config', hosts, 'test');
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ModelConfigError);
      expect(String(thrown)).not.toContain('synthetic-private-config');
      expect(thrown).not.toHaveProperty('cause');
      expect(warning).not.toHaveBeenCalled();
      await expect(
        loadModelGatewayConfig({
          configPath: 'nonexistent-model-config-fixture',
          allowlistPath: 'nonexistent-allowlist-fixture',
          environment: 'test',
        }),
      ).rejects.toBeInstanceOf(ModelConfigError);
    } finally {
      warning.mockRestore();
    }
  });
});
