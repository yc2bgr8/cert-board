import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  ModelConfigError,
  loadModelGatewayConfig,
  parseAllowedModelHosts,
  parseModelGatewayConfig,
} from './config.js';

const source = readFileSync(new URL('../../../../deploy/models.yaml', import.meta.url), 'utf8');
const hosts = ['openrouter.ai'];
describe('唯一YAML模型配置来源', () => {
  it('读出精确模型、价格、提供方和用途，不包含密钥值', () => {
    const config = parseModelGatewayConfig(source, hosts, 'test');
    expect(config.models).toHaveLength(1);
    expect(config.models[0]).toMatchObject({
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
    expect(config.models[0]).not.toHaveProperty('apiKey');
    expect(() => parseModelGatewayConfig(source, hosts, 'production')).toThrow(ModelConfigError);
    expect(
      parseModelGatewayConfig(
        source.replace('accepted: false', 'accepted: true'),
        hosts,
        'production',
      ).models[0]?.accepted,
    ).toBe(true);
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
