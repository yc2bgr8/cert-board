import { describe, expect, it } from 'vitest';
import {
  authResponseSchema,
  browserIdentitySchema,
  loginInputSchema,
  publicUserSchema,
  roleBindingSchema,
  type AuthorizationAction,
  type BrowserIdentity,
  type Role,
  type RoleBinding,
} from '@cert-board/shared';
import { authorize } from './authorization.js';

const userId = '10000000-0000-4000-8000-000000000001';
const otherUserId = '10000000-0000-4000-8000-000000000002';
const projectId = '20000000-0000-4000-8000-000000000001';
const otherProjectId = '20000000-0000-4000-8000-000000000002';
const sessionId = '30000000-0000-4000-8000-000000000001';
const resource = { projectId, ownerUserId: userId };

function identity(roleBindings: RoleBinding[]): BrowserIdentity {
  return {
    kind: 'browser',
    userId,
    username: 'ra',
    displayName: '注册人员',
    isDevelopment: true,
    sessionId,
    roles: roleBindings,
  };
}
const binding = (
  role: Role,
  scopeType: RoleBinding['scopeType'] = 'global',
  scopeId: string | null = null,
): RoleBinding => ({ role, scopeType, scopeId });

const roleOrder: Role[] = ['RA', 'RB', 'GM', 'SALES', 'TECH'];
const matrix: [AuthorizationAction, boolean[]][] = [
  ['project.read', [true, true, true, false, false]],
  ['project.write', [true, true, false, false, false]],
  ['record.read', [true, true, true, false, false]],
  ['record.write', [true, true, false, false, false]],
  ['document.read', [true, true, true, false, false]],
  ['document.write', [true, true, false, false, false]],
  ['workspace.read', [true, true, true, false, false]],
  ['workspace.write', [true, true, false, false, false]],
  ['conversation.read', [true, true, true, false, false]],
  ['conversation.write', [true, true, false, false, false]],
  ['review.decide', [false, false, false, false, false]],
  ['admin.manage', [false, false, false, false, true]],
  ['ops.read', [false, false, false, false, true]],
  ['sales.request.read', [false, false, false, true, false]],
  ['sales.request.write', [false, false, false, true, false]],
];

describe('角色与对象授权', () => {
  for (const [reviewKind, allowedRoles] of [
    ['registration', ['RA', 'RB']],
    ['management', ['GM']],
  ] as const) {
    for (const role of roleOrder) {
      it(`${role} 对 ${reviewKind} 审核按专属角色授权`, () => {
        expect(
          authorize(identity([binding(role)]), 'review.decide', { ...resource, reviewKind }),
        ).toBe((allowedRoles as readonly string[]).includes(role));
      });
    }
  }

  for (const [action, expected] of matrix) {
    for (const [index, role] of roleOrder.entries()) {
      it(`${role} 对 ${action} 的权限符合矩阵`, () => {
        expect(authorize(identity([binding(role)]), action, resource)).toBe(expected[index]);
      });
    }
  }

  it('项目授权只适用于匹配项目，缺少或另一个项目均拒绝', () => {
    const actor = identity([binding('RA', 'project', projectId)]);
    expect(authorize(actor, 'document.read', resource)).toBe(true);
    expect(authorize(actor, 'document.read', { ...resource, projectId: otherProjectId })).toBe(
      false,
    );
    expect(authorize(actor, 'document.read', { ownerUserId: userId })).toBe(false);
  });

  it('本人范围不能读写其他人的对象，也不能访问无明确所属用户的对象', () => {
    const actor = identity([binding('RA', 'own')]);
    expect(authorize(actor, 'workspace.write', resource)).toBe(true);
    expect(authorize(actor, 'workspace.write', { ...resource, ownerUserId: otherUserId })).toBe(
      false,
    );
    expect(authorize(actor, 'workspace.read', { projectId })).toBe(false);
  });

  it('即使全局角色或同一项目，对话也只能属于本人', () => {
    for (const role of ['RA', 'RB', 'GM'] as const) {
      for (const scope of [binding(role), binding(role, 'project', projectId)]) {
        expect(
          authorize(identity([scope]), 'conversation.read', {
            projectId,
            ownerUserId: otherUserId,
          }),
        ).toBe(false);
        expect(authorize(identity([scope]), 'conversation.read', { projectId })).toBe(false);
      }
    }
    expect(
      authorize(identity([binding('RA')]), 'conversation.write', { ownerUserId: otherUserId }),
    ).toBe(false);
  });

  it('销售即使有全局范围，也只能操作自己的请求', () => {
    for (const action of ['sales.request.read', 'sales.request.write']) {
      expect(authorize(identity([binding('SALES')]), action, { ownerUserId: userId })).toBe(true);
      expect(authorize(identity([binding('SALES')]), action, { ownerUserId: otherUserId })).toBe(
        false,
      );
      expect(authorize(identity([binding('SALES')]), action, {})).toBe(false);
    }
  });

  it('多个角色不能拼接权限与范围，但独立成立的授权仍有效', () => {
    const actor = identity([binding('RA', 'project', projectId), binding('SALES')]);
    expect(authorize(actor, 'project.read', { projectId: otherProjectId })).toBe(false);
    expect(authorize(actor, 'project.write', { projectId })).toBe(true);
    expect(authorize(actor, 'sales.request.write', resource)).toBe(true);
    const globalRegistrar = identity([binding('RA'), binding('SALES', 'own')]);
    expect(authorize(globalRegistrar, 'project.read', { projectId: otherProjectId })).toBe(true);
    expect(authorize(globalRegistrar, 'sales.request.read', { ownerUserId: otherUserId })).toBe(
      false,
    );
    expect(
      authorize(
        identity([binding('TECH', 'project', projectId), binding('RA')]),
        'admin.manage',
        resource,
      ),
    ).toBe(false);
  });

  it('全局管理与运维必须有全局 TECH 绑定', () => {
    for (const scope of [binding('TECH', 'project', projectId), binding('TECH', 'own')]) {
      expect(authorize(identity([scope]), 'admin.manage', resource)).toBe(false);
      expect(authorize(identity([scope]), 'ops.read', resource)).toBe(false);
    }
  });

  it('未登记动作、身份或范围不完整与畸形输入默认拒绝', () => {
    const actor = identity([binding('RA')]);
    for (const action of ['project.delete', '*', 'constructor', '__proto__', null, undefined]) {
      expect(authorize(actor, action, resource)).toBe(false);
    }
    expect(authorize(identity([]), 'project.read', resource)).toBe(false);
    expect(authorize(null, 'project.read', resource)).toBe(false);
    expect(authorize({ ...actor, kind: 'agent' }, 'project.read', resource)).toBe(false);
    expect(
      authorize({ ...actor, roles: [binding('RA', 'project')] }, 'project.read', resource),
    ).toBe(false);
    expect(authorize(actor, 'project.read', { projectId: 'untrusted' })).toBe(false);
    expect(authorize(actor, 'project.read', { ...resource, role: 'TECH' })).toBe(false);
    expect(authorize(actor, 'project.read', undefined)).toBe(true);
    expect(authorize(actor, 'conversation.read', undefined)).toBe(false);
    expect(authorize(actor, 'review.decide', { ...resource, reviewKind: 'unknown' })).toBe(false);
  });
});

describe('身份边界模式', () => {
  it('用户名格式与长度明确，密码保留原始空格且限制长度', () => {
    const password = '  fictional-password  ';
    expect(loginInputSchema.parse({ username: 'ra', password }).password).toBe(password);
    for (const username of ['r', 'RA', ' ra', 'ra ', 'a'.repeat(81), 'ra\n']) {
      expect(loginInputSchema.safeParse({ username, password }).success).toBe(false);
    }
    for (const password of ['x'.repeat(15), 'x'.repeat(257)]) {
      expect(loginInputSchema.safeParse({ username: 'ra', password }).success).toBe(false);
    }
    expect(loginInputSchema.safeParse({ username: 'ra', password, role: 'TECH' }).success).toBe(
      false,
    );
  });

  it('范围结构与数据库约束一致，不允许静默更正不一致的绑定', () => {
    expect(roleBindingSchema.safeParse(binding('RA', 'project', projectId)).success).toBe(true);
    expect(roleBindingSchema.safeParse(binding('RA', 'project')).success).toBe(false);
    expect(roleBindingSchema.safeParse(binding('RA', 'global', projectId)).success).toBe(false);
    expect(roleBindingSchema.safeParse(binding('RA', 'own', projectId)).success).toBe(false);
  });

  it('浏览器身份、对外用户与认证响应不接受秘密字段', () => {
    const actor = identity([binding('RA')]);
    expect(browserIdentitySchema.safeParse({ ...actor, tokenHash: 'forbidden' }).success).toBe(
      false,
    );
    const user = { id: userId, username: 'ra', displayName: '注册人员', roles: actor.roles };
    expect(publicUserSchema.parse(user)).toEqual(user);
    for (const secretField of ['passwordHash', 'password_hash', 'tokenHash', 'csrfTokenHash']) {
      expect(publicUserSchema.safeParse({ ...user, [secretField]: 'forbidden' }).success).toBe(
        false,
      );
    }
    const response = {
      user,
      csrfToken: 'fictional-csrf-value-'.repeat(3),
      expiresAt: '2026-11-18T07:00:00+08:00',
    };
    expect(authResponseSchema.safeParse(response).success).toBe(true);
    expect(
      authResponseSchema.safeParse({ ...response, csrfToken: response.csrfToken + '\n' }).success,
    ).toBe(false);
    expect(authResponseSchema.safeParse({ ...response, sessionId }).success).toBe(false);
    expect(
      authResponseSchema.safeParse({ ...response, expiresAt: '2026-11-18T07:00:00' }).success,
    ).toBe(false);
  });
});
