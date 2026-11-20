import type { Pool } from 'pg';
import { z } from 'zod';
import { AppError } from '../api/errors.js';

const reply = z.enum(['success', 'timeout', 'failure']);
type Reply = z.infer<typeof reply>;
const options = z.object({ initial: reply, retry: reply.default('success') }).strict();

export async function deliverNoticeCopy(
  send: (attempt: number) => Promise<Reply>,
  recordFailure: (attempt: number, result: Exclude<Reply, 'success'>) => Promise<void>,
) {
  for (const attempt of [1, 2]) {
    const result = await send(attempt).catch(() => 'failure' as const);
    if (result === 'success') return true;
    await recordFailure(attempt, result);
  }
  return false;
}

export async function processTestWechatCopy(pool: Pool, noticeId: string, simulation: unknown) {
  if (!['development', 'test'].includes(process.env.NODE_ENV ?? ''))
    throw new AppError(403, 'WECHAT_TEST_ONLY', '模拟企业微信仅在开发和测试环境使用。');
  const choice = options.safeParse(simulation);
  if (!z.uuid().safeParse(noticeId).success || !choice.success)
    throw new AppError(400, 'WECHAT_TEST_INVALID', '请用已登记的站内提醒编号和模拟回执。');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const source = await db.query('SELECT id FROM notification WHERE id=$1 FOR UPDATE', [noticeId]);
    if (!source.rowCount)
      throw new AppError(404, 'WECHAT_NOTICE_MISSING', '没有找到对应的站内提醒。');
    const existing = (
      await db.query<{ result: Reply }>(
        'SELECT result FROM simulated_wechat_copy WHERE notice_id=$1 ORDER BY attempt',
        [noticeId],
      )
    ).rows;
    let sent = existing.at(-1)?.result === 'success';
    let attempts = existing.length;
    if (!attempts)
      sent = await deliverNoticeCopy(
        async (attempt) => {
          const result = attempt === 1 ? choice.data.initial : choice.data.retry;
          await db.query(
            'INSERT INTO simulated_wechat_copy(notice_id,attempt,result) VALUES($1,$2,$3)',
            [noticeId, attempt, result],
          );
          attempts = attempt;
          return result;
        },
        async (_attempt, result) => {
          await db.query(
            "INSERT INTO audit_log(actor_kind,action,target_type,target_id) VALUES('system',$1,'notification',$2)",
            [`wechat.copy_${result}`, noticeId],
          );
        },
      );
    await db.query('COMMIT');
    return { sent, attempts };
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}
