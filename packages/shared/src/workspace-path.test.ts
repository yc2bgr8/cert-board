import { expect, test } from 'vitest';
import { workspacePathSchema } from './workspace-path.js';

test('工作区路径先NFC，支持中文相对目录', () => {
  expect(workspacePathSchema.parse('交付/e\u0301.md')).toBe('交付/é.md');
});
test('拒绝所有常见越界与路径别名，不依赖宿主机平台', () => {
  for (const value of [
    '/tmp/a',
    'C:/a',
    '../a',
    'a/../b',
    'a/./b',
    'a\\b',
    'a//b',
    'a/',
    'a\0b',
    'a\nb',
    'a./b',
    'a /b',
    'CON.txt',
    'a/LPT1',
    'a/\ud800',
  ])
    expect(workspacePathSchema.safeParse(value).success).toBe(false);
});
