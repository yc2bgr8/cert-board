import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { intakeReportSchema } from '@cert-board/shared';
import { createApp } from '../app.js';
import { AppError } from '../api/errors.js';
import { processDocumentParseTask } from '../documents/parse-tasks.js';
import { createIntegrationContext } from '../test-support/context.js';
import { processIntakeJob } from './service.js';
import { fixtureZip } from './test-archives.js';

const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex');

test('真实数据库接收浏览器资料包，保存重复路径及 eSTAR 子资料并公布解析统计', async () => {
  const context = await createIntegrationContext();
  const values = new Map<string, Buffer>();
  const store = {
    async put(value: Buffer) {
      const sha256 = sha(value);
      values.set(sha256, value);
      return { sha256, byteSize: value.length };
    },
    async get(sha256: string) {
      const value = values.get(sha256);
      if (!value) throw Error('fixture missing');
      return value;
    },
  };
  const app = createApp(
    { ...context.config, CERT_DOCSVC_URL: 'http://127.0.0.1:28082' },
    {
      database: context.pool,
      blobStore: store,
      checkDatabase: async () => undefined,
      checkStorage: async () => undefined,
      close: async () => undefined,
    },
  );
  try {
    const actor = await context.login();
    const content = Buffer.from('fictional content');
    const zip = fixtureZip([
      { name: 'duplicate-without-extension.bin', bytes: content },
      { name: '目录/predicate.pdf', bytes: content },
      { name: 'submission.pdf', bytes: Buffer.from('fictional container') },
    ]);
    const url = `/api/intake?name=demo.zip&projectId=${context.projectId}`;
    const post = (headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url,
        payload: zip,
        headers: { ...headers, 'content-type': 'application/octet-stream' },
      });
    expect(
      (await post({ origin: context.config.WEB_ORIGIN, 'sec-fetch-site': 'same-origin' }))
        .statusCode,
    ).toBe(401);
    const queued = await post(actor.headers);
    expect(queued.statusCode).toBe(202);
    const id = queued.json().id;
    const duplicate = await post(actor.headers);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ id, created: false });
    const get = async () =>
      intakeReportSchema.parse(
        (await app.inject({ url: `/api/intake/${id}`, headers: actor.headers })).json(),
      );
    expect((await get()).status).toBe('queued');
    expect(
      await processIntakeJob(context.pool, store, store, {
        inspectPdf: async (bytes) => (bytes.toString().includes('container') ? 'estar' : 'pdf'),
        estarAttachments: async () => [
          {
            name: 'demo.pdf',
            sourceNames: ['demo.pdf', 'fixture-alias'],
            sha256: sha(content),
            bytes: content,
          },
        ],
      }),
    ).toBe(true);
    const pending = await get();
    expect(pending.status).toBe('parsing');
    expect(pending.totals).toMatchObject({
      outerFiles: 3,
      embeddedFiles: 1,
      uniqueFiles: 2,
      duplicates: 2,
    });
    expect(pending.items.find((item) => item.embedded)).toMatchObject({
      parentPath: 'submission.pdf',
      sourceNames: ['demo.pdf', 'fixture-alias'],
      duplicate: true,
    });
    const parse = async () => [
      {
        pageNumber: 1,
        text: '合成入库资料',
        method: 'text' as const,
        locatorKind: 'physical_page' as const,
        ocrScore: null,
        isPlaceholder: false,
      },
    ];
    expect(await processDocumentParseTask(context.pool, store, { parse })).toBe(true);
    expect(await processDocumentParseTask(context.pool, store, { parse })).toBe(true);
    const ready = await get();
    expect(ready.status).toBe('complete');
    expect(ready.totals).toMatchObject({ ready: 4, failed: 0 });
    const changed = await app.inject({
      method: 'PATCH',
      url: `/api/intake/${id}/category`,
      headers: actor.headers,
      payload: { path: '目录/predicate.pdf', category: 'performance' },
    });
    expect(changed.statusCode).toBe(200);
    expect(
      intakeReportSchema
        .parse(changed.json())
        .items.find((item) => item.path === '目录/predicate.pdf'),
    ).toMatchObject({ category: 'performance', confidence: null });
    expect(
      (await context.pool.query('SELECT count(*)::int AS total FROM document_version')).rows[0]
        ?.total,
    ).toBe(2);
    const repeated = Buffer.from('fictional shared across separate packs');
    for (const suffix of ['one', 'two']) {
      const pending = await app.inject({
        method: 'POST',
        url: `/api/intake?projectId=${context.projectId}&name=${suffix}.zip`,
        headers: { ...actor.headers, 'content-type': 'application/octet-stream' },
        payload: fixtureZip([{ name: `${suffix}.pdf`, bytes: repeated }]),
      });
      expect(pending.statusCode).toBe(202);
    }
    const noAttachments = {
      inspectPdf: async () => 'pdf' as const,
      estarAttachments: async () => [],
    };
    expect(
      await Promise.all([
        processIntakeJob(context.pool, store, store, noAttachments),
        processIntakeJob(context.pool, store, store, noAttachments),
      ]),
    ).toEqual([true, true]);
    const matching = await context.pool.query(
      'SELECT count(*)::int AS total FROM document_version WHERE original_sha256=$1',
      [sha(repeated)],
    );
    expect(matching.rows[0]?.total).toBe(1);
    const catalog = await app.inject({
      url: `/api/projects/${context.projectId}/intakes`,
      headers: actor.headers,
    });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().items).toEqual(expect.arrayContaining([{ id, name: 'demo.zip' }]));
    const task = catalog
      .json()
      .items.find((entry: { id: string; name: string }) => entry.name === 'one.zip');
    await context.pool.query(
      "UPDATE intake_job SET state='failed',attempts=3,error_code='DOC_BUSY' WHERE id=$1",
      [task.id],
    );
    const retry = await app.inject({
      method: 'POST',
      url: `/api/intake/${task.id}/retry`,
      headers: actor.headers,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ id: task.id, status: 'queued', created: false });
    expect(await processIntakeJob(context.pool, store, store, noAttachments)).toBe(true);
    const partial = await app.inject({
      method: 'POST',
      url: `/api/intake?projectId=${context.projectId}&name=partial.zip`,
      headers: { ...actor.headers, 'content-type': 'application/octet-stream' },
      payload: fixtureZip([
        { name: 'invalid.pdf', bytes: Buffer.from('bad fixture') },
        { name: 'usable.pdf', bytes: Buffer.from('valid fixture') },
      ]),
    });
    expect(partial.statusCode).toBe(202);
    await processIntakeJob(context.pool, store, store, {
      inspectPdf: async (bytes) => (bytes.toString() === 'bad fixture' ? 'estar' : 'pdf'),
      estarAttachments: async () => {
        throw new AppError(422, 'DOC_XFA_INVALID', 'fixture');
      },
    });
    const partialReport = intakeReportSchema.parse(
      (
        await app.inject({
          url: `/api/intake/${partial.json().id}`,
          headers: actor.headers,
        })
      ).json(),
    );
    expect(partialReport.status).toBe('parsing');
    expect(partialReport.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'invalid.pdf', errorCode: 'DOC_XFA_INVALID' }),
        expect.objectContaining({ path: 'usable.pdf', parseStatus: 'queued', errorCode: null }),
      ]),
    );
  } finally {
    await app.close();
    await context.close();
  }
});
