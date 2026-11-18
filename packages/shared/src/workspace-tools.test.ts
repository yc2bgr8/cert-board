import { expect, test } from 'vitest';
import {
  workspaceToolListInputSchema,
  workspaceToolReadInputSchema,
  workspaceToolEditInputSchema,
  workspaceToolSaveInputSchema,
  workspaceToolSearchInputSchema,
  workspaceToolUndoStateSchema,
  workspaceToolWriteInputSchema,
} from './workspace-tools.js';

test('新文件省略预期哈希与显式 null 等价，仍拒不合法哈希', () => {
  const input = { path: '交付/核查记录.md', content: '# 核查记录' };
  expect(workspaceToolWriteInputSchema.parse(input)).toEqual({ ...input, expectedSha256: null });
  expect(
    workspaceToolWriteInputSchema.safeParse({ ...input, expectedSha256: 'null' }).success,
  ).toBe(false);
});

test('工作区工具只接受相对NFC路径和有界分页，不接受模型指定副本', () => {
  expect(workspaceToolReadInputSchema.parse({ path: '草稿/e\u0301.md' }).path).toBe('草稿/é.md');
  for (const path of ['../secret', 'C:/secret', '草稿\\secret', '/absolute', 'NUL.txt'])
    expect(workspaceToolReadInputSchema.safeParse({ path }).success).toBe(false);
  expect(workspaceToolListInputSchema.safeParse({ limit: 21 }).success).toBe(false);
  expect(workspaceToolReadInputSchema.safeParse({ path: 'AGENTS.md', limit: 12001 }).success).toBe(
    false,
  );
  expect(
    workspaceToolListInputSchema.safeParse({ draftId: '10000000-0000-4000-8000-000000000001' })
      .success,
  ).toBe(false);
});
test('编辑与发布必须带真实文件或副本版本，不能以空片段做不明确替换', () => {
  const input = {
    path: '交付/结果.md',
    expectedSha256: 'a'.repeat(64),
    oldText: '旧文',
    newText: '新文',
  };
  expect(workspaceToolEditInputSchema.safeParse(input).success).toBe(true);
  expect(workspaceToolEditInputSchema.safeParse({ ...input, oldText: '' }).success).toBe(false);
  expect(workspaceToolEditInputSchema.safeParse({ ...input, newText: '\ud800' }).success).toBe(
    false,
  );
  expect(workspaceToolSaveInputSchema.safeParse({ summary: '保存' }).success).toBe(false);
  expect(
    workspaceToolSaveInputSchema.parse({ summary: '保存', expectedDraftVersion: 1 })
      .expectedDraftVersion,
  ).toBe(1);
});
test('搜索续读绑定快照和完整位置，撤销记录只允许快照引用不含正文', () => {
  expect(workspaceToolSearchInputSchema.safeParse({ query: 'a'.repeat(201) }).success).toBe(false);
  expect(
    workspaceToolSearchInputSchema.safeParse({ query: 'x', cursor: { path: 'a.md', offset: 0 } })
      .success,
  ).toBe(false);
  const state = { snapshotSha256: 'a'.repeat(64), byteSize: 100, publishes: true };
  expect(workspaceToolUndoStateSchema.safeParse(state).success).toBe(true);
  expect(workspaceToolUndoStateSchema.safeParse({ ...state, content: '正文' }).success).toBe(false);
});
