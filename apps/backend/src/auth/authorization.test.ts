import { describe, expect, it } from 'vitest';
import {
  agentIdentitySchema,
  authResponseSchema,
  browserIdentitySchema,
  loginInputSchema,
  publicUserSchema,
  authorizationActions,
  conversationCreateSchema,
  projectCreateSchema,
  type BrowserIdentity,
} from '@cert-board/shared';
import { authorize } from './authorization.js';
const userId = '10000000-0000-4000-8000-000000000001',
  other = '10000000-0000-4000-8000-000000000002';
const projectId = '20000000-0000-4000-8000-000000000001',
  sessionId = '30000000-0000-4000-8000-000000000001';
const identity = (isManagement = false): BrowserIdentity => ({
  kind: 'browser',
  userId,
  username: 'zhangsan',
  displayName: '张三',
  isDevelopment: true,
  isManagement,
  sessionId,
});
const resource = { projectId, ownerUserId: userId, reviewKind: 'registration' as const };
describe('部门成员与独立管理权限', () => {
  for (const management of [false, true])
    for (const action of authorizationActions)
      it(`${management ? '管理成员' : '普通成员'} ${action}`, () => {
        expect(authorize(identity(management), action, resource)).toBe(
          ['admin.manage', 'ops.read'].includes(action) ? management : true,
        );
      });
  it('不同成员同等业务权限，负责人不形成独占权限', () => {
    for (const action of [
      'project.read',
      'project.write',
      'document.read',
      'document.write',
      'workspace.read',
      'workspace.write',
      'record.read',
      'record.write',
      'review.decide',
    ])
      expect(authorize(identity(), action, { ...resource, ownerUserId: other })).toBe(true);
    expect(authorize(identity(), 'conversation.read', { ...resource, ownerUserId: other })).toBe(
      true,
    );
    for (const action of ['conversation.write', 'approval.decide']) {
      expect(authorize(identity(), action, { ...resource, ownerUserId: other })).toBe(false);
      expect(authorize(identity(true), action, { ...resource, ownerUserId: other })).toBe(false);
    }
  });
  it('系统维护权限不能代替管理层决策，也不能赋予Agent审批或维护入口', () => {
    expect(
      authorize(identity(true), 'review.decide', { ...resource, reviewKind: 'management' }),
    ).toBe(false);
    const { sessionId: _session, kind: _kind, ...base } = identity(true);
    const agent = agentIdentitySchema.parse({ ...base, kind: 'agent', runId: sessionId });
    expect(authorize(agent, 'document.read', resource)).toBe(true);
    for (const action of ['review.decide', 'approval.decide', 'admin.manage', 'ops.read'])
      expect(authorize(agent, action, resource)).toBe(false);
    expect(browserIdentitySchema.safeParse(agent).success).toBe(false);
  });
  it('未知动作、旧角色或伪造字段默认拒绝', () => {
    for (const action of [
      'project.delete',
      'sales.request.read',
      '*',
      'constructor',
      null,
      undefined,
    ])
      expect(authorize(identity(), action, resource)).toBe(false);
    for (const actor of [
      null,
      { ...identity(), roles: [] },
      { ...identity(), isManagement: 'true' },
    ])
      expect(authorize(actor, 'project.read', resource)).toBe(false);
    expect(authorize(identity(), 'conversation.read', {})).toBe(false);
    expect(authorize(identity(), 'review.decide', {})).toBe(false);
    expect(authorize(identity(), 'document.read', { projectId: 'invalid' })).toBe(false);
  });
});
describe('身份与新默认模式边界', () => {
  it('登录保持用户名与密码格式要求，不接受客户端权限字段', () => {
    const password = '  fictional-password  ';
    expect(loginInputSchema.parse({ username: 'zhangsan', password }).password).toBe(password);
    for (const username of [
      'r',
      'ZHANGSAN',
      ' zhangsan',
      'zhangsan ',
      'a'.repeat(81),
      'zhangsan\n',
    ])
      expect(loginInputSchema.safeParse({ username, password }).success).toBe(false);
    for (const extra of [{ role: 'TECH' }, { roles: [] }, { isManagement: true }])
      expect(loginInputSchema.safeParse({ username: 'zhangsan', password, ...extra }).success).toBe(
        false,
      );
    for (const invalid of ['x'.repeat(15), 'x'.repeat(257)])
      expect(loginInputSchema.safeParse({ username: 'zhangsan', password: invalid }).success).toBe(
        false,
      );
  });
  it('公开身份仅展示人名和管理能力，不接收密码/会话摘要或旧角色', () => {
    const user = { id: userId, username: 'zhangsan', displayName: '张三', isManagement: false };
    expect(publicUserSchema.parse(user)).toEqual(user);
    for (const field of ['roles', 'passwordHash', 'password_hash', 'tokenHash', 'csrfTokenHash'])
      expect(publicUserSchema.safeParse({ ...user, [field]: 'forbidden' }).success).toBe(false);
    const response = {
      user,
      csrfToken: 'synthetic-csrf-'.repeat(4),
      expiresAt: '2026-11-18T07:00:00+08:00',
    };
    expect(authResponseSchema.safeParse(response).success).toBe(true);
    expect(authResponseSchema.safeParse({ ...response, sessionId }).success).toBe(false);
  });
  it('新对话默认ask和注册Agent，三模式明确，不沿用execute', () => {
    const input = { projectId, title: '核查' };
    expect(conversationCreateSchema.parse(input)).toMatchObject({
      permissionMode: 'ask',
      agentCode: 'registration',
    });
    for (const mode of ['read_only', 'ask', 'full'])
      expect(conversationCreateSchema.safeParse({ ...input, permissionMode: mode }).success).toBe(
        true,
      );
    expect(conversationCreateSchema.safeParse({ ...input, mode: 'execute' }).success).toBe(false);
    expect(
      conversationCreateSchema.safeParse({ ...input, permissionMode: 'execute' }).success,
    ).toBe(false);
    expect(conversationCreateSchema.safeParse({ ...input, agentCode: 'sales' }).success).toBe(
      false,
    );
  });
  it('复核人可以未指定，D22不成为强制第二人规则', () => {
    const input = { name: 'L08', projectType: 'registration', market: 'US', pathway: '510(k)' };
    expect(projectCreateSchema.parse(input).reviewerUserId).toBeNull();
    expect(projectCreateSchema.parse({ ...input, reviewerUserId: userId }).reviewerUserId).toBe(
      userId,
    );
  });
});
