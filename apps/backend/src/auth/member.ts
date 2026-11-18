import type { Pool } from 'pg';
import { serviceIdentitySchema, type ServiceIdentity } from '@cert-board/shared';
import { AppError } from '../api/errors.js';

export async function currentServiceIdentity(
  database: Pick<Pool, 'query'>,
  input: ServiceIdentity,
  options: { lock?: boolean } = {},
): Promise<ServiceIdentity> {
  const parsed = serviceIdentitySchema.safeParse(input);
  if (!parsed.success) throw new AppError(403, 'MEMBER_INACTIVE', '成员身份无效，请重新登录。');
  const row = (
    await database.query<{
      id: string;
      username: string;
      display_name: string;
      is_development: boolean;
      is_management: boolean;
    }>(
      `SELECT id,username,display_name,is_development,is_management FROM app_user
    WHERE id=$1 AND status='active' AND ($2::boolean=false OR is_development=false)${options.lock ? ' FOR SHARE' : ''}`,
      [parsed.data.userId, process.env.NODE_ENV === 'production'],
    )
  ).rows[0];
  if (!row)
    throw new AppError(403, 'MEMBER_INACTIVE', '成员账号已停用或不能用于当前环境，请联系管理员。');
  return serviceIdentitySchema.parse({
    ...parsed.data,
    username: row.username,
    displayName: row.display_name,
    isDevelopment: row.is_development,
    isManagement: row.is_management,
  });
}
