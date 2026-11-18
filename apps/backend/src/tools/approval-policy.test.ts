import { expect, test } from 'vitest';
import type { ToolMetadata, ToolPolicyContext } from '@cert-board/shared';
import { decideTool } from './policy.js';

const metadata: ToolMetadata = {
  name: 'write_record',
  version: '1',
  publication: 'published',
  effect: 'reversible_write',
  modes: ['read_only', 'ask', 'full'],
  approvalInAsk: true,
  outputDataLevel: 'internal',
  authorizationAction: 'record.write',
  description: {
    purpose: '更新记录。',
    whenToUse: '记录已核对的结果。',
    avoid: '不能审批。',
    parameters: 'value为新值。',
    example: { value: '待核对' },
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
  ['read_only', 'read', false, 'allow'],
  ['read_only', 'reversible_write', false, 'deny'],
  ['read_only', 'external', false, 'deny'],
  ['read_only', 'irreversible', false, 'deny'],
  ['ask', 'read', false, 'allow'],
  ['ask', 'reversible_write', false, 'allow'],
  ['ask', 'reversible_write', true, 'require_approval'],
  ['ask', 'external', true, 'propose'],
  ['ask', 'irreversible', true, 'deny'],
  ['full', 'read', false, 'allow'],
  ['full', 'reversible_write', true, 'allow'],
  ['full', 'external', true, 'propose'],
  ['full', 'irreversible', true, 'deny'],
] as const)('%s/%s/先问%s的判定为%s', (permissionMode, effect, approvalInAsk, expected) => {
  expect(
    decideTool({ ...metadata, effect, approvalInAsk }, { ...context, permissionMode }).decision,
  ).toBe(expected);
});

test('工具漏声明请求批准策略时默认拒绝', () => {
  expect(decideTool({ ...metadata, approvalInAsk: undefined }, context)).toMatchObject({
    decision: 'deny',
    code: 'TOOL_CONTRACT_INVALID',
  });
});
test('会话授权仅免询问，不能越过只读、对象、目标、撤销和外部提案', () => {
  const granted = { ...context, approvalGranted: true };
  expect(decideTool(metadata, granted).decision).toBe('allow');
  for (const restriction of [
    { permissionMode: 'read_only' },
    { resourceAllowed: false },
    { goalStatus: 'paused' },
    { hasUndo: false },
  ])
    expect(decideTool(metadata, { ...granted, ...restriction }).decision).toBe('deny');
  expect(decideTool({ ...metadata, effect: 'external' }, granted).decision).toBe('propose');
  expect(decideTool({ ...metadata, effect: 'irreversible' }, granted).decision).toBe('deny');
});
test('过程批准和管理决定不能伪装成模型工具', () => {
  for (const name of [
    'approval_decision',
    'approve_tool',
    'review_decision',
    'proposal_decision',
    'workspace_freeze',
  ]) {
    expect(decideTool({ ...metadata, name, effect: 'read' }, context)).toMatchObject({
      decision: 'deny',
      code: 'TOOL_BROWSER_ONLY',
    });
  }
});
