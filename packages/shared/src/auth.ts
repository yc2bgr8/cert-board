import { z } from 'zod';

export const usernameSchema = z
  .string()
  .min(2)
  .max(80)
  .regex(
    /^[a-z0-9][a-z0-9_.@-]{1,79}$/,
    '用户名应为 2–80 个小写字母、数字或 _.@-，并以字母或数字开头。',
  );

const displayNameSchema = z
  .string()
  .min(1)
  .max(120)
  .refine((value) => value.trim().length > 0, '显示名称不能为空。');

export const browserIdentitySchema = z
  .object({
    kind: z.literal('browser'),
    userId: z.string().uuid('用户编号无效。'),
    username: usernameSchema,
    displayName: displayNameSchema,
    isDevelopment: z.boolean(),
    sessionId: z.string().uuid('会话编号无效。'),
    isManagement: z.boolean(),
  })
  .strict();
export type BrowserIdentity = z.infer<typeof browserIdentitySchema>;

export const agentIdentitySchema = browserIdentitySchema
  .omit({ kind: true, sessionId: true })
  .extend({ kind: z.literal('agent'), runId: z.string().uuid() })
  .strict();
export type AgentIdentity = z.infer<typeof agentIdentitySchema>;
export const serviceIdentitySchema = z.discriminatedUnion('kind', [
  browserIdentitySchema,
  agentIdentitySchema,
]);
export type ServiceIdentity = z.infer<typeof serviceIdentitySchema>;

export const loginInputSchema = z
  .object({
    username: usernameSchema,
    password: z.string().min(16, '密码至少需要 16 个字符。').max(256, '密码不能超过 256 个字符。'),
  })
  .strict();
export type LoginInput = z.infer<typeof loginInputSchema>;

export const publicUserSchema = z
  .object({
    id: z.string().uuid('用户编号无效。'),
    username: usernameSchema,
    displayName: displayNameSchema,
    isManagement: z.boolean(),
  })
  .strict();
export type PublicUser = z.infer<typeof publicUserSchema>;

export const authResponseSchema = z
  .object({
    user: publicUserSchema,
    csrfToken: z
      .string()
      .min(32)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/, 'CSRF 令牌格式无效，请重新登录。'),
    expiresAt: z.string().datetime({ offset: true, message: '会话到期时间必须带时区。' }),
  })
  .strict();
export type AuthResponse = z.infer<typeof authResponseSchema>;

export const authorizationActions = [
  'project.read',
  'project.write',
  'record.read',
  'record.write',
  'document.read',
  'document.write',
  'workspace.read',
  'workspace.write',
  'conversation.read',
  'conversation.write',
  'review.decide',
  'approval.decide',
  'admin.manage',
  'ops.read',
] as const;
export const authorizationActionSchema = z.enum(authorizationActions, {
  error: '动作未登记，已拒绝访问。',
});
export type AuthorizationAction = z.infer<typeof authorizationActionSchema>;

export const authorizationResourceSchema = z
  .object({
    projectId: z.string().uuid('项目编号无效。').nullable().optional(),
    ownerUserId: z.string().uuid('所属用户编号无效。').nullable().optional(),
    reviewKind: z
      .enum(['registration', 'management'], { error: '审核类型无效，请确认审核卡类型。' })
      .optional(),
  })
  .strict();
export type AuthorizationResource = z.infer<typeof authorizationResourceSchema>;
