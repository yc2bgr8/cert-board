import { createHash, randomUUID } from 'node:crypto';
import { browserIdentitySchema, workspaceFileListSchema } from '@cert-board/shared';
import { expect, test } from 'vitest';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import { createIntegrationContext } from '../test-support/context.js';
import { createDraft, saveDraft, writeDraftFile } from '../workspace/service.js';
import { seedInFlightDevelopment } from './in-flight-seed.js';

function memoryStore(): DocumentBlobStore {
  const blobs = new Map<string, Buffer>();
  return {
    async put(content) {
      const sha256 = createHash('sha256').update(content).digest('hex');
      blobs.set(sha256, Buffer.from(content));
      return { sha256, byteSize: content.byteLength };
    },
    async get(hash) {
      const value = blobs.get(hash);
      if (!value) throw new Error('合成文件缺失');
      return Buffer.from(value);
    },
  };
}

test('在途演练可并发重跑，节点与业务日期待核，保留后续人工版本', async () => {
  const context = await createIntegrationContext();
  const storage = memoryStore();
  const environment = { NODE_ENV: 'test' };
  try {
    const responses = await Promise.all([
      seedInFlightDevelopment(context.pool, storage, environment),
      seedInFlightDevelopment(context.pool, storage, environment),
    ]);
    expect(responses.map((items) => items.filter(({ created }) => created).length).sort()).toEqual([
      0, 2,
    ]);
    const first = responses[0]![0]!;
    const { headers } = await context.login('MEMBER_A');
    for (const seed of responses[0]!) {
      const listed = await context.app.inject({
        method: 'GET',
        url: `/api/workspaces/${seed.workspaceId}/files`,
        headers,
      });
      expect(listed.statusCode).toBe(200);
      expect(workspaceFileListSchema.parse(listed.json()).items).toContainEqual(
        expect.objectContaining({ path: '计划/节点.json', mediaType: 'application/json' }),
      );
    }
    const storedProject = (
      await context.pool.query('SELECT * FROM cert_project WHERE id=$1', [first.projectId])
    ).rows[0];
    const storedHash = (
      await context.pool.query<{ after_hash: string }>(
        "SELECT after_hash FROM audit_log WHERE action='development.seed' AND target_type='cert_project' AND target_id=$1",
        [first.projectId],
      )
    ).rows[0]?.after_hash;
    expect(storedHash).toBe(
      createHash('sha256').update(JSON.stringify(storedProject)).digest('hex'),
    );
    const rows = (
      await context.pool.query<{ sha256: string; project_type: string; target_at: string | null }>(
        `SELECT p.project_type,p.target_at,f.sha256 FROM cert_project p JOIN workspace w ON w.project_id=p.id
       JOIN workspace_file f ON f.version_id=w.current_version_id AND f.path='计划/节点.json'
       WHERE p.development_seed_key LIKE 'development:synthetic:%-in-flight:v1' ORDER BY p.id`,
      )
    ).rows;
    expect(rows.map(({ project_type, target_at }) => [project_type, target_at])).toEqual([
      ['registration', null],
      ['maintenance', null],
    ]);
    for (const row of rows) {
      const fixture = JSON.parse((await storage.get(row.sha256)).toString('utf8'));
      expect(fixture.synthetic).toBe(true);
      expect(fixture.nodes).toHaveLength(3);
      expect(
        fixture.nodes.every(
          (node: { actualOn: unknown; plannedOn: unknown; status: string }) =>
            node.actualOn === null && node.plannedOn === null && node.status === 'missing_evidence',
        ),
      ).toBe(true);
    }
    const userId = context.userId('MEMBER_A');
    const browser = browserIdentitySchema.parse({
      kind: 'browser',
      userId,
      username: 'zhangsan',
      displayName: '合成成员',
      sessionId: randomUUID(),
      isDevelopment: true,
      isManagement: false,
    });
    const conversation = (
      await context.pool.query<{ id: string }>(
        "INSERT INTO conversation(project_id,goal_id,user_id,agent_code,title) VALUES($1,$2,$3,'registration','人工补充计划') RETURNING id",
        [first.projectId, first.goalId, userId],
      )
    ).rows[0]!.id;
    const draft = await createDraft(context.pool, browser, conversation);
    await writeDraftFile(context.pool, storage, browser, draft.id, {
      path: '草稿/人工备注.md',
      content: '保留人工新增的待核事项。',
      expectedSha256: null,
    });
    const saved = await saveDraft(
      context.pool,
      storage,
      browser,
      draft.id,
      '保存人工新增的待核事项',
    );
    const rerun = await seedInFlightDevelopment(context.pool, storage, environment);
    expect(rerun.every(({ created }) => !created)).toBe(true);
    expect(
      (
        await context.pool.query('SELECT current_version_id FROM workspace WHERE id=$1', [
          first.workspaceId,
        ])
      ).rows[0]?.current_version_id,
    ).toBe(saved.version.id);
    const audit = await context.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_log WHERE action IN ('development.seed','workspace.seeded') AND target_id=ANY($1::text[])",
      [
        responses[0]!.flatMap(({ projectId, goalId, workspaceId }) => [
          projectId,
          goalId,
          workspaceId,
        ]),
      ],
    );
    expect(audit.rows[0]?.count).toBe(6);
  } finally {
    await context.close();
  }
});

test('后一项目写入失败时两套演练记录回滚，生产禁止初始化', async () => {
  const context = await createIntegrationContext();
  const storage = memoryStore();
  let writes = 0;
  try {
    await expect(
      seedInFlightDevelopment(context.pool, storage, { NODE_ENV: 'production' }),
    ).rejects.toThrow('仅可');
    await expect(
      seedInFlightDevelopment(
        context.pool,
        {
          ...storage,
          async put(bytes) {
            if (++writes === 6) throw new Error('模拟隔离文件存储失败');
            return storage.put(bytes);
          },
        },
        { NODE_ENV: 'test' },
      ),
    ).rejects.toThrow('存储失败');
    const result = await context.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM cert_project WHERE development_seed_key LIKE 'development:synthetic:%-in-flight:v1'",
    );
    expect(result.rows[0]?.count).toBe(0);
    await expect(
      seedInFlightDevelopment(context.pool, storage, { NODE_ENV: 'test' }),
    ).resolves.toEqual([
      expect.objectContaining({ created: true }),
      expect.objectContaining({ created: true }),
    ]);
  } finally {
    await context.close();
  }
});
