import type { PoolClient } from 'pg';
import { AppError } from '../api/errors.js';

export type OwnedRun = {
  id: string;
  user_id: string;
  conversation_id: string;
  status: string;
  last_event_seq: string;
  lease_owner: string | null;
  lease_generation: string;
  lease_expires_at: Date | null;
};

export async function lockOwnedRun(tx: PoolClient, runId: string, userId: string) {
  const denied = () =>
    new AppError(403, 'RUN_MUTATION_FORBIDDEN', '运行与对话不属于当前用户，已拒绝修改。');
  const located = await tx.query<{ conversation_id: string }>(
    'SELECT conversation_id FROM run WHERE id=$1 AND user_id=$2',
    [runId, userId],
  );
  if (!located.rows[0]) throw denied();
  // UPDATE run的数据库守卫会共享锁conversation；先显式取得它，避免与conv→run执行器互等。
  const conversation = await tx.query(
    'SELECT id FROM conversation WHERE id=$1 AND user_id=$2 FOR SHARE',
    [located.rows[0].conversation_id, userId],
  );
  if (!conversation.rowCount) throw denied();
  const result = await tx.query<OwnedRun>(
    'SELECT id,user_id,conversation_id,status,last_event_seq,lease_owner,lease_generation,lease_expires_at FROM run WHERE id=$1 AND user_id=$2 FOR UPDATE',
    [runId, userId],
  );
  const run = result.rows[0];
  if (!run || run.conversation_id !== located.rows[0].conversation_id) throw denied();
  return run;
}
