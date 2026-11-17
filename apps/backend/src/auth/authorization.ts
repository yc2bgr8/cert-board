import {
  authorizationActionSchema,
  authorizationResourceSchema,
  browserIdentitySchema,
  type AuthorizationAction,
  type AuthorizationResource,
  type Role,
  type RoleBinding,
} from '@cert-board/shared';

const policy: Readonly<Record<AuthorizationAction, readonly Role[]>> = {
  'project.read': ['RA', 'RB', 'GM'],
  'project.write': ['RA', 'RB'],
  'record.read': ['RA', 'RB', 'GM'],
  'record.write': ['RA', 'RB'],
  'document.read': ['RA', 'RB', 'GM'],
  'document.write': ['RA', 'RB'],
  'workspace.read': ['RA', 'RB', 'GM'],
  'workspace.write': ['RA', 'RB'],
  'conversation.read': ['RA', 'RB', 'GM'],
  'conversation.write': ['RA', 'RB'],
  'review.decide': ['RA', 'RB', 'GM'],
  'admin.manage': ['TECH'],
  'ops.read': ['TECH'],
  'sales.request.read': ['SALES'],
  'sales.request.write': ['SALES'],
};

function scopeMatches(binding: RoleBinding, resource: AuthorizationResource, userId: string) {
  switch (binding.scopeType) {
    case 'global':
      return true;
    case 'project':
      return resource.projectId != null && binding.scopeId === resource.projectId;
    case 'own':
      return resource.ownerUserId === userId;
  }
}

// 对象范围必须由服务端从已读取的业务对象构造，不能直接使用请求中的所属用户或项目字段。
export function authorize(identity: unknown, action: unknown, resource: unknown = {}): boolean {
  const actorResult = browserIdentitySchema.safeParse(identity);
  const actionResult = authorizationActionSchema.safeParse(action);
  const resourceResult = authorizationResourceSchema.safeParse(resource);
  if (!actorResult.success || !actionResult.success || !resourceResult.success) return false;

  const actor = actorResult.data;
  const permittedAction = actionResult.data;
  const target = resourceResult.data;
  if (permittedAction === 'review.decide' && target.reviewKind === undefined) return false;
  if (
    (permittedAction.startsWith('conversation.') || permittedAction.startsWith('sales.request.')) &&
    target.ownerUserId !== actor.userId
  )
    return false;

  const globalAdministration = permittedAction === 'admin.manage' || permittedAction === 'ops.read';
  // 角色和范围必须来自同一条绑定，禁止组合两个角色的权限与范围来扩大授权。
  return actor.roles.some(
    (binding) =>
      policy[permittedAction].includes(binding.role) &&
      (permittedAction !== 'review.decide' ||
        (target.reviewKind === 'management'
          ? binding.role === 'GM'
          : binding.role === 'RA' || binding.role === 'RB')) &&
      (!globalAdministration || binding.scopeType === 'global') &&
      scopeMatches(binding, target, actor.userId),
  );
}
