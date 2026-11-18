import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { composeInvocation, redactOutput, toWslPath } from './dev.mjs';

const credentials = {
  POSTGRES_PASSWORD: 'fictional-postgres-password',
  MINIO_ROOT_USER: 'fictional-minio-user',
  MINIO_ROOT_PASSWORD: 'fictional-minio-password',
};

describe('本地依赖服务脚本', () => {
  it('Windows 路径转换为 WSL 路径，空格和中文保持在一个参数里', () => {
    expect(toWslPath('C:\\Users\\开发\\cert board')).toBe('/mnt/c/Users/开发/cert board');
    const invocation = composeInvocation('up', 'C:\\工作目录\\cert board', 'win32', credentials, {
      PATH: 'tools',
    });
    expect(invocation.executable).toBe('wsl.exe');
    expect(invocation.args.slice(0, 4)).toEqual(['-d', 'Ubuntu-24.04', '--exec', 'docker']);
    expect(invocation.args).toContain('/mnt/c/工作目录/cert board/deploy/compose.dev.yml');
    expect(invocation.environment.WSLENV).toBe(
      'POSTGRES_PASSWORD:MINIO_ROOT_USER:MINIO_ROOT_PASSWORD',
    );
    expect(invocation.args.join(' ')).not.toContain(credentials.POSTGRES_PASSWORD);
    expect(() => toWslPath('\\\\server\\share')).toThrow('不支持 UNC');
  });

  it('Linux 直接调用 docker，操作只固定到 cert-board，不删除命名卷', () => {
    for (const action of ['up', 'down', 'status']) {
      const invocation = composeInvocation(action, '/work/cert-board', 'linux', credentials, {});
      expect(invocation.executable).toBe('docker');
      expect(invocation.args.slice(0, 3)).toEqual(['compose', '--project-name', 'cert-board']);
      expect(invocation.args).not.toContain('--volumes');
      expect(invocation.args).not.toContain('--remove-orphans');
      expect(invocation.args.join(' ')).not.toMatch(/dc-idp|idp-cert-qa/);
    }
    expect(() => composeInvocation('down --volumes', '/work', 'linux', credentials)).toThrow(
      '未知操作',
    );
  });

  it('环境按白名单传递，不能把模型密钥或其他 Compose 项目带入子进程', () => {
    const invocation = composeInvocation('up', '/work', 'linux', credentials, {
      PATH: '/usr/bin',
      OPENROUTER_API_KEY: 'do-not-forward',
      COMPOSE_PROJECT_NAME: 'dc-idp',
      WSLENV: 'OPENROUTER_API_KEY',
    });
    expect(invocation.environment).toEqual({ PATH: '/usr/bin', ...credentials });
    expect(() => composeInvocation('up', '/work', 'linux', {})).toThrow('POSTGRES_PASSWORD');
    expect(redactOutput(`failed ${credentials.POSTGRES_PASSWORD}`, credentials)).toBe(
      'failed [已脱敏]',
    );
  });

  it('Compose 端口只绑定回环、数据使用命名卷，初始化只建立测试库', () => {
    const compose = readFileSync(new URL('../deploy/compose.dev.yml', import.meta.url), 'utf8');
    const ports = [...compose.matchAll(/- '(127\.0\.0\.1:\d+:\d+)'/g)].map((match) => match[1]);
    expect(ports).toEqual([
      '127.0.0.1:25432:5432',
      '127.0.0.1:29000:9000',
      '127.0.0.1:29001:9001',
      '127.0.0.1:28085:3128',
    ]);
    expect(compose).toContain('postgres_data:/var/lib/postgresql/data');
    expect(compose).toContain(
      './deploy/postgres/001-test-database.sql:/docker-entrypoint-initdb.d/001-test-database.sql:ro',
    );
    expect(compose).toContain('minio_data:/data');
    expect(compose).toContain('driver: bridge');
    expect(compose).toContain('internal: true');
    const postgresSection = compose.split('  postgres:')[1].split('  minio:')[0];
    const minioSection = compose.split('  minio:')[1].split('  relay:')[0];
    expect(postgresSection).toContain('networks: [internal]');
    expect(minioSection).toContain('networks: [internal]');
    expect(postgresSection).not.toContain('ports:');
    expect(minioSection).not.toContain('ports:');
    expect(compose).toContain('networks: [internal, ingress]');
    expect(compose).not.toContain('OPENROUTER');
    expect(compose).not.toContain('/mnt/c');
    const sql = readFileSync(
      new URL('../deploy/postgres/001-test-database.sql', import.meta.url),
      'utf8',
    );
    expect(sql).toContain('CREATE DATABASE cert_board_test OWNER cert_board;');
    expect(sql).not.toMatch(/CREATE TABLE/i);
  });

  it('中继仅转发固定内部服务，不挂载凭据或通用代理', () => {
    const config = readFileSync(new URL('../deploy/relay/nginx.conf', import.meta.url), 'utf8');
    expect([...config.matchAll(/server (\S+) resolve;/g)].map((match) => match[1])).toEqual([
      'postgres:5432',
      'minio:9000',
      'minio:9001',
    ]);
    expect(config).not.toMatch(/proxy_pass\s+\$/);
    const compose = readFileSync(new URL('../deploy/compose.dev.yml', import.meta.url), 'utf8');
    const relaySection = compose.split('  relay:')[1].split('\nnetworks:')[0];
    expect(relaySection).not.toContain('environment:');
    expect(relaySection).toContain('read_only: true');
    expect(relaySection).toContain('cap_drop: [ALL]');
  });
});
