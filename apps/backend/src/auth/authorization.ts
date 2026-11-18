import {
  authorizationActionSchema,
  authorizationResourceSchema,
  serviceIdentitySchema,
} from '@cert-board/shared';

// 这里只接受由服务层构造的身份和对象归属；账号状态与管理权限须在事务中从数据库重验。
export function authorize(identity: unknown, action: unknown, resource: unknown = {}): boolean {
  const actor = serviceIdentitySchema.safeParse(identity);
  const operation = authorizationActionSchema.safeParse(action);
  const target = authorizationResourceSchema.safeParse(resource);
  if (!actor.success || !operation.success || !target.success) return false;
  if (operation.data === 'admin.manage' || operation.data === 'ops.read')
    return actor.data.kind === 'browser' && actor.data.isManagement;
  if (operation.data === 'review.decide')
    return actor.data.kind === 'browser' && target.data.reviewKind === 'registration';
  if (operation.data === 'approval.decide')
    return actor.data.kind === 'browser' && target.data.ownerUserId === actor.data.userId;
  if (operation.data === 'conversation.write') return target.data.ownerUserId === actor.data.userId;
  if (operation.data === 'conversation.read') return target.data.ownerUserId != null;
  return true;
}
