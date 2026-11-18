import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createReviewTestContext } from './test-support.js';

type Context = Awaited<ReturnType<typeof createReviewTestContext>>;
let context: Context | undefined;
afterEach(async () => {
  await context?.close();
  context = undefined;
});
async function setup(risk: 'standard' | 'high' = 'standard') {
  const value = await createReviewTestContext({ risk });
  context = value;
  await value.submit();
  const card = (
    await value.pool.query<{ id: string; content_hash: string }>(
      'SELECT id,content_hash FROM review_card',
    )
  ).rows[0]!;
  await value.login('MEMBER_A');
  await value.login('MEMBER_B');
  const sessions = await value.pool.query<{ id: string; user_id: string }>(
    'SELECT id,user_id FROM web_session',
  );
  const session = (role: 'MEMBER_A' | 'MEMBER_B') =>
    sessions.rows.find((row) => row.user_id === value.userId(role))!.id;
  const judgment = (
    role: 'MEMBER_A' | 'MEMBER_B' = 'MEMBER_A',
    hash = card.content_hash,
    sourceVersion = 1,
  ) =>
    value.pool.query(
      `INSERT INTO review_judgment(card_id,actor_user_id,session_id,request_key,
      source_version,content_hash,statement) VALUES($1,$2,$3,$4,$5,$6,'我已独立核对虚构资料。')`,
      [card.id, value.userId(role), session(role), randomUUID(), sourceVersion, hash],
    );
  const reject = (
    role: 'MEMBER_A' | 'MEMBER_B' = 'MEMBER_A',
    hash = card.content_hash,
    sourceVersion = 1,
  ) =>
    value.pool.query(
      `INSERT INTO review_decision(card_id,actor_user_id,session_id,request_key,
      source_version,content_hash,action,reason) VALUES($1,$2,$3,$4,$5,$6,'rejected','请核对原件。')`,
      [card.id, value.userId(role), session(role), randomUUID(), sourceVersion, hash],
    );
  return { ...value, card, session, judgment, reject };
}

describe('审核数据的数据库保护', () => {
  it('卡片的内容、来源、风险与哈希不能改写，状态必须逐版推进', async () => {
    const c = await setup();
    for (const assignment of [
      "structured_result='{}'::jsonb",
      "check_report='{}'::jsonb",
      "evidence_refs='[]'::jsonb",
      "diff='{}'::jsonb",
      "risk='high'",
      "content_hash=repeat('0',64)",
      `workspace_version_id='${randomUUID()}'`,
    ]) {
      await expect(
        c.pool.query(`UPDATE review_card SET ${assignment} WHERE id=$1`, [c.card.id]),
      ).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      c.pool.query("UPDATE review_card SET status='cancelled' WHERE id=$1", [c.card.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await c.pool.query("UPDATE review_card SET status='cancelled',version=2 WHERE id=$1", [
      c.card.id,
    ]);
    await expect(
      c.pool.query("UPDATE review_card SET status='pending',version=3 WHERE id=$1", [c.card.id]),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('高风险不再要求先写判断，决定仍绑定当前内容版本与有效浏览器会话', async () => {
    const c = await setup('high');
    await expect(c.judgment('MEMBER_A', '0'.repeat(64))).rejects.toMatchObject({ code: '23514' });
    await expect(c.judgment('MEMBER_A', c.card.content_hash, 2)).rejects.toMatchObject({
      code: '23514',
    });
    await expect(c.reject('MEMBER_A', '0'.repeat(64))).rejects.toMatchObject({ code: '23514' });
    await expect(c.reject('MEMBER_A', c.card.content_hash, 2)).rejects.toMatchObject({
      code: '23514',
    });
    await c.pool.query('UPDATE web_session SET revoked_at=now() WHERE id=$1', [
      c.session('MEMBER_B'),
    ]);
    await expect(c.reject('MEMBER_B')).rejects.toMatchObject({ code: '42501' });
    expect((await c.pool.query('SELECT count(*)::int AS n FROM review_judgment')).rows[0].n).toBe(
      0,
    );
    await c.reject('MEMBER_A');
    expect((await c.pool.query('SELECT actor_user_id FROM review_decision')).rows).toEqual([
      { actor_user_id: c.userId('MEMBER_A') },
    ]);
    expect((await c.pool.query('SELECT count(*)::int AS n FROM review_judgment')).rows[0].n).toBe(
      0,
    );
  });
  it('判断和决定拒绝更新、删除及整表清空，语义SQL读角色没有读取权限', async () => {
    const c = await setup('high');
    await c.judgment();
    const originalJudgment = (await c.pool.query('SELECT * FROM review_judgment')).rows;
    await c.reject();
    for (const table of ['review_judgment', 'review_decision']) {
      for (const query of [
        `UPDATE ${table} SET content_hash=repeat('0',64)`,
        `DELETE FROM ${table}`,
        `TRUNCATE ${table}`,
      ]) {
        await expect(c.pool.query(query)).rejects.toMatchObject({ code: '42501' });
      }
    }
    const rights = await c.pool.query<{ allowed: boolean }>(`SELECT
      has_table_privilege('cert_board_reader','review_card','SELECT') OR
      has_table_privilege('cert_board_reader','review_judgment','SELECT') OR
      has_table_privilege('cert_board_reader','review_decision','SELECT') AS allowed`);
    expect(rights.rows[0]?.allowed).toBe(false);
    expect((await c.pool.query('SELECT * FROM review_judgment')).rows).toEqual(originalJudgment);
  });
  it('批准快照必须与卡片的工作区和决定人绑定', async () => {
    const c = await setup();
    const snapshot = (
      await c.pool.query<{ id: string }>(
        `INSERT INTO submission_snapshot
      (project_id,sequence,kind,file_manifest,manifest_sha256,created_by,workspace_version_id)
      VALUES($1,1,'approved_review','[]',repeat('0',64),$2,$3) RETURNING id`,
        [c.projectId, c.userId('MEMBER_B'), c.workspaceVersion],
      )
    ).rows[0]!.id;
    await expect(
      c.pool.query(
        `INSERT INTO review_decision(card_id,actor_user_id,session_id,
      request_key,source_version,content_hash,action,snapshot_id)
      VALUES($1,$2,$3,$4,1,$5,'approved',$6)`,
        [
          c.card.id,
          c.userId('MEMBER_A'),
          c.session('MEMBER_A'),
          randomUUID(),
          c.card.content_hash,
          snapshot,
        ],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await c.pool.query(
      `INSERT INTO review_decision(card_id,actor_user_id,session_id,
      request_key,source_version,content_hash,action,snapshot_id)
      VALUES($1,$2,$3,$4,1,$5,'approved',$6)`,
      [
        c.card.id,
        c.userId('MEMBER_B'),
        c.session('MEMBER_B'),
        randomUUID(),
        c.card.content_hash,
        snapshot,
      ],
    );
  });
  it('审核卡即使尚未有人工决定也不能被删除或清空', async () => {
    const c = await setup();
    await expect(
      c.pool.query('DELETE FROM review_card WHERE id=$1', [c.card.id]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(c.pool.query('TRUNCATE review_card CASCADE')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('取消判断门限仍不允许绕过登记工具与撤销凭据创建审核卡', async () => {
    const c = await setup('high');
    await expect(
      c.pool.query(
        `INSERT INTO review_card(id,project_id,goal_id,conversation_id,run_id,invocation_id,created_by,
       workspace_version_id,skill_id,skill_version,risk,card_type,structured_result,check_report,diff,
       evidence_refs,content_hash,data_level)
       SELECT gen_random_uuid(),project_id,goal_id,conversation_id,run_id,invocation_id,created_by,
       workspace_version_id,skill_id,skill_version,risk,card_type,structured_result,check_report,diff,
       evidence_refs,content_hash,data_level FROM review_card WHERE id=$1`,
        [c.card.id],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
