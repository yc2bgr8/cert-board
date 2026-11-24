import type { Pool } from 'pg';
import {
  appendRunEventSchema,
  runEventRecordSchema,
  runEventListOptionsSchema,
  runEventListSchema,
  projectIdSchema,
  serviceIdentitySchema,
  type ServiceIdentity,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { authorize } from '../auth/authorization.js';
import { currentServiceIdentity } from '../auth/member.js';
import { lockOwnedRun } from './lock.js';

const columns = `e.id,e.run_id AS "runId",e.seq,e.type,e.invocation_id AS "invocationId",e.request_id AS "requestId",e.content_hash AS "contentHash",
e.sandbox_input_hashes AS "sandboxInputHashes",e.sandbox_output_hashes AS "sandboxOutputHashes",e.cert_query AS "certQuery",e.data_level AS "dataLevel",e.reason_code AS "reasonCode",
e.input_tokens AS "inputTokens",e.output_tokens AS "outputTokens",e.total_tokens AS "totalTokens",e.cost_nano AS "costNano",e.duration_ms AS "durationMs",e.created_at AS "createdAt"`;
function dto(row: Record<string, unknown>) {
  return runEventRecordSchema.parse({
    ...row,
    seq: Number(row.seq),
    inputTokens: row.inputTokens === null ? null : Number(row.inputTokens),
    outputTokens: row.outputTokens === null ? null : Number(row.outputTokens),
    totalTokens: row.totalTokens === null ? null : Number(row.totalTokens),
    durationMs: row.durationMs === null ? null : Number(row.durationMs),
    createdAt: (row.createdAt as Date).toISOString(),
  });
}
const missing = () =>
  new AppError(404, 'RUN_EVENTS_NOT_FOUND', '未找到可访问的运行事件，请从项目对话重新打开。');

export async function appendRunEvent(pool: Pool, input: unknown) {
  const parsed = appendRunEventSchema.safeParse(input);
  if (!parsed.success)
    throw new AppError(
      400,
      'RUN_EVENT_INVALID',
      '执行事件只能包含已登记类型、原因、编号、哈希和数值，不能把正文塞入字段。',
    );
  const { runId, userId, event } = parsed.data;
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const run = await lockOwnedRun(tx, runId, userId);
    if (
      event.invocationId &&
      !(
        await tx.query('SELECT id FROM tool_invocation WHERE id=$1 AND run_id=$2 AND user_id=$3', [
          event.invocationId,
          runId,
          userId,
        ])
      ).rowCount
    )
      throw new AppError(
        403,
        'RUN_EVENT_REFERENCE_FORBIDDEN',
        '工具调用引用不属于当前运行，已拒绝写入事件。',
      );
    if (
      event.requestId &&
      !(
        await tx.query(
          'SELECT id FROM usage_ledger WHERE request_key=$1 AND run_id=$2 AND user_id=$3',
          [event.requestId, runId, userId],
        )
      ).rowCount
    )
      throw new AppError(
        403,
        'RUN_EVENT_REFERENCE_FORBIDDEN',
        '模型计量引用不属于当前运行，已拒绝写入事件。',
      );
    if (
      event.certQuery &&
      (event.type !== 'tool_completed' ||
        !event.invocationId ||
        !(
          await tx.query(
            'SELECT id FROM tool_invocation WHERE id=$1 AND tool_name=$2 AND status=$3',
            [event.invocationId, 'cert_query', 'completed'],
          )
        ).rowCount)
    )
      throw new AppError(
        400,
        'RUN_EVENT_CERT_QUERY_INVALID',
        '台账查询回执只关联已完成的台账查询。',
      );
    const seq = Number(run.last_event_seq) + 1;
    if (!Number.isSafeInteger(seq))
      throw new AppError(409, 'RUN_EVENT_SEQUENCE_LIMIT', '运行事件序号已达上限，请新建运行。');
    await tx.query(
      'UPDATE run SET last_event_seq=$1,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$2',
      [seq, runId],
    );
    const saved = await tx.query<Record<string, unknown>>(
      `INSERT INTO run_event AS e(run_id,seq,type,invocation_id,request_id,content_hash,data_level,reason_code,input_tokens,output_tokens,total_tokens,cost_nano,duration_ms,sandbox_input_hashes,sandbox_output_hashes,cert_query)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING ${columns}`,
      [
        runId,
        seq,
        event.type,
        event.invocationId ?? null,
        event.requestId ?? null,
        event.contentHash ?? null,
        event.dataLevel ?? null,
        event.reasonCode ?? null,
        event.inputTokens ?? null,
        event.outputTokens ?? null,
        event.totalTokens ?? null,
        event.costNano ?? null,
        event.durationMs ?? null,
        event.sandboxInputHashes ?? null,
        event.sandboxOutputHashes ?? null,
        event.certQuery ?? null,
      ],
    );
    const record = dto(saved.rows[0]!);
    await tx.query('COMMIT');
    return record;
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError(
      500,
      'RUN_EVENT_APPEND_FAILED',
      '执行事件写入失败，序号未推进，请核对运行记录。',
    );
  } finally {
    tx.release();
  }
}

export async function listRunEvents(
  pool: Pool,
  identity: ServiceIdentity,
  runId: string,
  options: unknown = {},
) {
  const actor = serviceIdentitySchema.safeParse(identity),
    page = runEventListOptionsSchema.safeParse(options);
  if (!actor.success || !projectIdSchema.safeParse(runId).success || !page.success)
    throw new AppError(
      400,
      'RUN_EVENT_QUERY_INVALID',
      '运行编号或分页位置无效，请使用返回的续读序号。',
    );
  const viewer = await currentServiceIdentity(pool, actor.data);
  const source = await pool.query<{
    user_id: string;
    project_id: string | null;
    project_owner: string | null;
  }>(
    `SELECT r.user_id,r.project_id,p.owner_user_id AS project_owner FROM run r LEFT JOIN cert_project p ON p.id=r.project_id WHERE r.id=$1`,
    [runId],
  );
  const run = source.rows[0];
  if (
    !run ||
    !authorize(viewer, 'conversation.read', {
      projectId: run.project_id,
      ownerUserId: run.user_id,
    }) ||
    (run.project_id &&
      !authorize(viewer, 'project.read', {
        projectId: run.project_id,
        ownerUserId: run.project_owner,
      }))
  )
    throw missing();
  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${columns} FROM run_event e WHERE e.run_id=$1 AND e.seq>$2 ORDER BY e.seq LIMIT $3`,
    [runId, page.data.afterSeq, page.data.limit + 1],
  );
  const hasMore = result.rows.length > page.data.limit,
    items = result.rows.slice(0, page.data.limit).map(dto);
  return runEventListSchema.parse({
    items,
    hasMore,
    nextAfterSeq: hasMore ? (items.at(-1)?.seq ?? null) : null,
  });
}
