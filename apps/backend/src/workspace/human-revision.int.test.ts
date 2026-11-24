import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { humanRevisionViewSchema, reviewSubmitResultSchema } from '@cert-board/shared';
import { createApp } from '../app.js';
import { createTestBlobStore } from '../documents/test-blob-store.js';
import { createReviewTestContext } from '../reviews/test-support.js';

test('浏览器把人工修改稿保存在新版本并保留原稿、审阅状态和技能出处', async () => {
  const c = await createReviewTestContext();
  const storage = await createTestBlobStore();
  const app = createApp(c.config, {
    database: c.pool,
    blobStore: storage.store,
    checkDatabase: async () => undefined,
    checkStorage: async () => undefined,
    close: async () => undefined,
  });
  try {
    const path = '交付/核查报告.md';
    const appendix = '交付/合成附录.txt';
    const original = await storage.store.put(Buffer.from('范围\n\n合成旧结论\n\n依据'));
    const secondary = await storage.store.put(Buffer.from('合成附录旧稿'));
    const {
      rows: [source],
    } = await c.pool.query<{ id: string }>(
      `INSERT INTO workspace_version(workspace_id,project_id,number,parent_version_id,author_user_id,author_type,summary,data_level)
        VALUES($1,$2,2,$3,$4,'ai','合成 Agent 稿','internal') RETURNING id`,
      [c.workspaceId, c.projectId, c.workspaceVersion, c.caller.userId],
    );
    const sourceId = source!.id;
    await c.pool.query(
      `INSERT INTO workspace_file(version_id,path,sha256,byte_size,data_level,media_type)
        VALUES($1,$2,$3,$4,'internal','text/markdown; charset=utf-8'),($1,$5,$6,$7,'internal','text/plain')`,
      [
        sourceId,
        path,
        original.sha256,
        original.byteSize,
        appendix,
        secondary.sha256,
        secondary.byteSize,
      ],
    );
    await c.pool.query('UPDATE workspace SET current_version_id=$2,version=version+1 WHERE id=$1', [
      c.workspaceId,
      sourceId,
    ]);
    const card = reviewSubmitResultSchema.parse(
      (await c.submit({ ...c.submission, workspaceVersion: sourceId })).data,
    );
    const reviewer = await c.login('MEMBER_B');
    const url = `/api/workspaces/${c.workspaceId}/human-revisions`;
    const payload = {
      reviewId: card.reviewId,
      sourceVersionId: sourceId,
      expectedCurrentVersionId: sourceId,
      path,
      requestKey: randomUUID(),
      text: '范围\n\n合成人工结论\n\n依据',
      dataLevel: 'confidential',
    };
    const send = (input: object, headers: Record<string, string> = reviewer.headers) =>
      app.inject({ method: 'POST', url, headers, payload: input });
    const { 'x-csrf-token': _csrf, ...withoutCsrf } = reviewer.headers;
    expect((await send(payload, withoutCsrf)).statusCode).toBe(403);
    expect((await send({ ...payload, path: '交付/无关稿.md' })).statusCode).toBe(409);
    expect((await send({ ...payload, text: '范围\n\n合成旧结论\n\n依据' })).statusCode).toBe(409);
    const result = await send(payload);
    expect(result.statusCode).toBe(200);
    const revision = humanRevisionViewSchema.parse(result.json());
    expect(revision).toMatchObject({
      reviewId: card.reviewId,
      sourceVersionId: sourceId,
      path,
      skillId: card.skill.id,
      skillVersion: card.skill.version,
      version: {
        number: 3,
        parentVersionId: sourceId,
        authorType: 'human',
        authorUserId: c.userId('MEMBER_B'),
        dataLevel: 'confidential',
      },
      difference: {
        added: 1,
        removed: 1,
        paragraphs: [
          { kind: 'removed', number: 2, text: '合成旧结论' },
          { kind: 'added', number: 2, text: '合成人工结论' },
        ],
      },
    });
    expect((await send(payload)).json()).toEqual(revision);
    expect((await send({ ...payload, requestKey: randomUUID() })).statusCode).toBe(409);
    expect(
      (
        await app.inject({ url: `${url}?reviewId=${card.reviewId}`, headers: reviewer.headers })
      ).json(),
    ).toEqual({ items: [revision] });
    expect(
      (await c.pool.query('SELECT status FROM review_card WHERE id=$1', [card.reviewId])).rows,
    ).toEqual([{ status: 'pending' }]);
    expect(
      (
        await c.pool.query('SELECT sha256 FROM workspace_file WHERE version_id=$1 AND path=$2', [
          sourceId,
          path,
        ])
      ).rows,
    ).toEqual([{ sha256: original.sha256 }]);
    const previousFile = await send({
      ...payload,
      expectedCurrentVersionId: revision.version.id,
      requestKey: randomUUID(),
    });
    expect(previousFile.statusCode).toBe(409);
    expect(previousFile.body).toContain('HUMAN_REVISION_FILE_CHANGED');
    const second = await send({
      ...payload,
      expectedCurrentVersionId: revision.version.id,
      requestKey: randomUUID(),
      path: appendix,
      text: '合成附录新稿',
    });
    expect(second.statusCode).toBe(200);
    const secondVersion = humanRevisionViewSchema.parse(second.json()).version;
    expect(secondVersion.parentVersionId).toBe(revision.version.id);
    const preservedFile = await c.pool.query(
      'SELECT sha256 FROM workspace_file WHERE version_id=ANY($1::uuid[]) AND path=$2',
      [[revision.version.id, secondVersion.id], path],
    );
    expect(preservedFile.rows).toHaveLength(2);
    expect(preservedFile.rows[0]).toEqual(preservedFile.rows[1]);
    await expect(
      c.pool.query('DELETE FROM human_revision WHERE id=$1', [revision.id]),
    ).rejects.toMatchObject({ code: '55000' });
  } finally {
    await app.close();
    await storage.dispose();
    await c.close();
  }
});
