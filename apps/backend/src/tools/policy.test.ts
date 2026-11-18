import { expect, test } from 'vitest';
import { decideTool, toolDescription } from './policy.js';
import type { ToolMetadata, ToolPolicyContext } from '@cert-board/shared';

const metadata: ToolMetadata = {
  name: 'fixture_update',
  version: 'test-v1',
  publication: 'published',
  effect: 'reversible_write',
  modes: ['read_only', 'ask', 'full'],
  approvalInAsk: false,
  outputDataLevel: 'internal',
  authorizationAction: 'record.write',
  description: {
    purpose: '更新虚构测试记录。',
    whenToUse: '测试可撤销写入时。',
    avoid: '不要用于审批；审批由浏览器完成。',
    parameters: 'value是示例值，expectedVersion是已读取版本。',
    example: { value: '示例', expectedVersion: 1 },
  },
};
const context: ToolPolicyContext = {
  permissionMode: 'ask',
  approvalGranted: false,
  goalStatus: 'active',
  hasUndo: true,
  resourceAllowed: true,
};

test.each([
  ['未知工具', metadata, context, false, 'TOOL_UNREGISTERED'],
  ['缺少级别', { ...metadata, effect: undefined }, context, true, 'TOOL_EFFECT_UNDECLARED'],
  ['不可逆', { ...metadata, effect: 'irreversible' }, context, true, 'TOOL_IRREVERSIBLE'],
  ['只读强行写', metadata, { ...context, permissionMode: 'read_only' }, true, 'TOOL_READ_ONLY'],
  ['没有undo', metadata, { ...context, hasUndo: false }, true, 'TOOL_UNDO_REQUIRED'],
  ['跨范围', metadata, { ...context, resourceAllowed: false }, true, 'TOOL_FORBIDDEN'],
  ['未发布', { ...metadata, publication: 'draft' }, context, true, 'TOOL_NOT_PUBLISHED'],
  [
    '审批伪装',
    { ...metadata, name: 'approve_review', effect: 'read' },
    context,
    true,
    'TOOL_BROWSER_ONLY',
  ],
] as const)('%s被默认拒绝', (_label, spec, ctx, registered, code) => {
  expect(decideTool(spec, ctx, registered)).toMatchObject({ decision: 'deny', code });
});
test.each([
  'waiting_materials',
  'waiting_external',
  'waiting_decision',
  'pending_review',
  'human_controlled',
  'paused',
  'completed',
  'cancelled',
  null,
])('目标%s拒绝写入但允许授权读取', (state) => {
  expect(decideTool(metadata, { ...context, goalStatus: state }).decision).toBe('deny');
  expect(
    decideTool(
      { ...metadata, effect: 'read', authorizationAction: 'record.read' },
      { ...context, goalStatus: state },
    ).decision,
  ).toBe('allow');
});
test('外部动作仅提案，只读模式仍拒绝', () => {
  const tool = { ...metadata, effect: 'external' };
  expect(decideTool(tool, context).decision).toBe('propose');
  expect(decideTool(tool, { ...context, permissionMode: 'read_only' }).decision).toBe('deny');
});
test('给模型的说明包含适用范围、替代操作、参数和示例', () => {
  const text = toolDescription(metadata);
  for (const part of ['何时使用', '何时不用', '参数', '示例', '浏览器'])
    expect(text).toContain(part);
});
