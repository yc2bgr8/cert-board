import { describe, expect, test } from 'vitest';
import { inspectContent } from './secret-scan.mjs';

describe('提交前密钥检查', () => {
  test('拒绝环境文件且允许空示例', () => {
    expect(inspectContent('.env.local', '')).toBe(true);
    expect(inspectContent('.ENV.LOCAL', '')).toBe(true);
    expect(inspectContent('.env.example', 'OPENROUTER_API_KEY=')).toBe(false);
  });
  test('识别令牌模式而不需要把完整令牌写入测试代码', () => {
    expect(inspectContent('code.ts', ['sk-or', 'v1', 'a'.repeat(64)].join('-'))).toBe(true);
  });
  test('精确拦截本地密钥并拒绝私钥', () => {
    expect(inspectContent('file', 'example-sensitive-value', ['example-sensitive-value'])).toBe(
      true,
    );
    expect(inspectContent('file', 'abc1234567', ['abc1234567'])).toBe(true);
    expect(inspectContent('file', ['-----BEGIN', 'PRIVATE KEY-----'].join(' '))).toBe(true);
    expect(inspectContent('file', '普通文档内容')).toBe(false);
  });
});
