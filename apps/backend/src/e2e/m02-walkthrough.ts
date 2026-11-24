import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import type pg from 'pg';
import type { Page } from 'playwright-core';
import {
  officialLookupResultSchema,
  reviewEvidenceRefSchema,
  structuredSubmissionSchema,
} from '@cert-board/shared';
import { l08PublicCriteria as input } from '../../../../evals/m02/l08-public.js';
import { nanoToUsd } from '../budget/meter.js';
import type { BlobStore } from '../documents/blob-store.js';
import { ingestParsedDocument } from '../documents/service.js';
import { officialRequestUrl } from '../official/providers.js';

const publicQueries = {
  registration: officialRequestUrl({
    dataset: 'fda_registration',
    registrationNumber: input.registrationNumber,
    listedProductCode: input.productCode,
    listedKNumber: input.kNumber,
  }),
  applicant: officialRequestUrl({
    dataset: 'fda_registration_company',
    companyName: input.applicant,
  }),
  gudid: officialRequestUrl({
    dataset: 'fda_gudid_search',
    productCode: input.productCode,
    kNumber: input.kNumber,
    brandNames: input.brandNames,
  }),
};

export async function prepareM02Walkthrough(pool: pg.Pool, blobs: BlobStore) {
  const project = randomUUID();
  const goal = randomUUID();
  const workspace = randomUUID();
  const version = randomUUID();
  const blocker = randomUUID();
  const conversation = randomUUID();
  const name = `L08 公开资料定时核查 ${project.slice(0, 6)}`;
  const brief = await blobs.put(
    Buffer.from(
      `# L08 公开资料核查\n这是独立验收项目。输入只包含公开的检索条件和合成归档提示。使用 M02。三项查询分别是：fda_registration 同时填写登记号、LRK 与 K 号；fda_registration_company 按申请人全名；fda_gudid_search 填写 LRK、K 号和四个商品全名（按资料列出的顺序）。记录列名机构、登记号、到期年份、美国代理人企业、四个名称、申请人登记和 UDI，每项待核实。成功记录需留官方档案，查询不成功如实列项。送审 claims 中，申请人登记用 id=applicant_lookup，公开 UDI 用 id=udi_lookup，两项都引用各自档案，状态用 unverified。观察到成功零条时，该项 value 写“本次查询条件下未查到”；成功返回记录时写“本次查询首批匹配 N 条”，N 按实际首批记录数。完成待核实的年度注册和年费站内提醒，提交审核。`,
    ),
  );
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const {
      rows: [user],
    } = await db.query<{ id: string }>(
      "SELECT id FROM app_user WHERE username='zhangsan' AND is_development AND status='active'",
    );
    assert.ok(user);
    await db.query(
      "INSERT INTO cert_project(id,name,project_type,market,pathway,jurisdiction_tz,owner_user_id) VALUES($1,$2,'maintenance','US','年度注册',$3,$4)",
      [project, name, input.jurisdictionTz, user.id],
    );
    await db.query(
      "INSERT INTO goal(id,project_id,owner_user_id,title,acceptance_criteria) VALUES($1,$2,$3,'公开资料定时核查','查明登记与 UDI，生成站内提醒和待审核的核查记录。')",
      [goal, project, user.id],
    );
    await db.query('INSERT INTO workspace(id,project_id) VALUES($1,$2)', [workspace, project]);
    await db.query(
      "INSERT INTO workspace_version(id,workspace_id,project_id,number,author_type,summary,data_level) VALUES($1,$2,$3,1,'system','公开资料核查说明','internal')",
      [version, workspace, project],
    );
    await db.query(
      "INSERT INTO workspace_file(version_id,path,sha256,byte_size,data_level,media_type) VALUES($1,'AGENTS.md',$2,$3,'internal','text/markdown')",
      [version, brief.sha256, brief.byteSize],
    );
    await db.query('UPDATE workspace SET current_version_id=$1 WHERE id=$2', [version, workspace]);
    // 模拟当前有一轮在等待，控制定时事件只能在负责人退出后入队。
    await db.query(
      "INSERT INTO conversation(id,project_id,goal_id,user_id,title,agent_code) VALUES($1,$2,$3,$4,'验收用运行占位','maintenance')",
      [conversation, project, goal, user.id],
    );
    await db.query(
      "INSERT INTO run(id,conversation_id,project_id,goal_id,user_id,status) VALUES($1,$2,$3,$4,$5,'waiting')",
      [blocker, conversation, project, goal, user.id],
    );
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
  const samples = [
    {
      key: 'TEST-M02-PUBLIC',
      name: 'L08 企业注册与 UDI 公开检索条件',
      text: `产品代码 ${input.productCode}；510(k) ${input.kNumber}；检索登记号 ${input.registrationNumber}；申请人 ${input.applicant}。商品名：${input.brandNames.join('；')}。法域时区 ${input.jurisdictionTz}。以上为检索线索。`,
    },
    {
      key: 'TEST-M02-ARCHIVE',
      name: 'L08 年费与美国代理人档案缺口（合成）',
      text: '当前独立验收资料未包含实际付款凭证或签署后的美国代理人协议。确认真实缴费与协议有效期留给注册人员处理。',
    },
  ];
  for (const doc of samples) {
    await ingestParsedDocument(pool, blobs, {
      projectId: project,
      sourceKey: doc.key,
      name: doc.name,
      sourcePath: `walkthrough/${doc.key}.txt`,
      sourceSnapshot: createHash('sha256').update(doc.text).digest('hex'),
      dataLevel: 'internal',
      authorType: 'human',
      pages: [{ pageNumber: 1, text: doc.text, method: 'text', locatorKind: 'physical_page' }],
    });
  }
  return { project, goal, name, blocker };
}

export async function waitForM02OfflineReview(pool: pg.Pool, goalId: string, startedAt: Date) {
  const until = Date.now() + 15 * 60_000;
  while (Date.now() < until) {
    const {
      rows: [row],
    } = await pool.query<{
      run_id: string;
      conversation_id: string;
      run_status: string;
      card_id: string | null;
      browser_online: boolean;
      browser_signed_out: boolean;
    }>(
      `SELECT r.id AS run_id,r.conversation_id,r.status AS run_status,c.id AS card_id,
        EXISTS(SELECT 1 FROM web_session s WHERE s.user_id=r.user_id AND s.created_at>=$2 AND s.revoked_at IS NULL AND s.expires_at>now()) AS browser_online,
        EXISTS(SELECT 1 FROM web_session s WHERE s.user_id=r.user_id AND s.created_at>=$2 AND s.revoked_at<=r.created_at) AS browser_signed_out
       FROM goal_event e JOIN run r ON r.id=e.wake_run_id
       LEFT JOIN review_card c ON c.run_id=r.id AND c.status='pending' AND c.skill_id='M02'
       WHERE e.goal_id=$1 AND e.source='timer' AND r.trigger_type='wakeup' LIMIT 1`,
      [goalId, startedAt],
    );
    if (row) {
      assert.ok(row.browser_signed_out && !row.browser_online, '应在本次走查会话退出后启动核查');
      if (row.card_id)
        return { run: row.run_id, conversation: row.conversation_id, card: row.card_id };
      assert.ok(
        ['queued', 'running'].includes(row.run_status),
        `定时核查终止，运行状态 ${row.run_status}`,
      );
    }
    await wait(1100);
  }
  throw new Error('M02_OFFLINE_REVIEW_TIMEOUT');
}

export async function inspectM02Walkthrough(
  page: Page,
  pool: pg.Pool,
  goal: string,
  run: string,
  cardId: string,
) {
  const { rows } = await pool.query<{ data: unknown }>(
    `SELECT r.content_json->'result'->'data' AS data FROM tool_invocation i
      JOIN conversation_tool_result r ON r.invocation_id=i.id
      WHERE i.run_id=$1 AND i.status='completed' AND i.tool_name='official_lookup'`,
    [run],
  );
  const receipts = rows.map(({ data }) => officialLookupResultSchema.parse(data));
  const submitted = (
    await pool.query<{ evidence_refs: unknown; structured_result: unknown }>(
      "SELECT evidence_refs,structured_result FROM review_card WHERE id=$1 AND run_id=$2 AND status='pending'",
      [cardId, run],
    )
  ).rows[0];
  assert.ok(submitted);
  const submission = structuredSubmissionSchema.parse(submitted.structured_result);
  const report = [
    submission.conclusion,
    ...submission.claims.map(({ object, field, value }) => `${object} ${field} ${value}`),
    ...submission.uncertain,
  ].join('\n');
  const citations = reviewEvidenceRefSchema.array().parse(submitted.evidence_refs);
  const official = Object.entries(publicQueries).map(([kind, url]) => {
    const receipt = receipts.find(
      (result) => result.status === 'ok' && result.evidence?.archive.url === url,
    );
    assert.ok(
      receipt?.status === 'ok' && receipt.evidence && !receipt.cached,
      `缺少 ${kind} 本次真实官方档案`,
    );
    assert.ok(
      citations.some(({ documentId }) => documentId === receipt.evidence!.documentId),
      `审核卡缺少 ${kind} 档案引文`,
    );
    if (kind !== 'registration') {
      const claimId = kind === 'applicant' ? 'applicant_lookup' : 'udi_lookup';
      const matches = receipt.records.length;
      const claim = submission.claims.find(({ id }) => id === claimId);
      assert.ok(claim && claim.status === 'unverified', `${kind} 结论未留待核实`);
      assert.equal(
        claim.value,
        matches ? `本次查询首批匹配 ${matches} 条` : '本次查询条件下未查到',
      );
      assert.ok(
        claim.sources.some(({ documentId }) => documentId === receipt.evidence!.documentId),
        `${kind} 结论未引用本次查询档案`,
      );
    }
    return {
      kind,
      fetchedAt: receipt.fetchedAt,
      matches: receipt.records.length,
      records: receipt.records,
    };
  });
  const listing = official[0]?.records.find(
    (record) =>
      record.company &&
      record.identifier === input.registrationNumber &&
      record.registrationExpiryYear &&
      record.usAgentBusiness &&
      input.brandNames.every((name) =>
        record.proprietaryNames?.some((actual) => actual.toLowerCase() === name.toLowerCase()),
      ),
  );
  assert.ok(listing, '列名回执缺少用例所需的登记字段或完整商品名；请核对新公开记录');
  for (const value of [
    listing.company,
    listing.identifier,
    `${listing.registrationExpiryYear}`,
    listing.usAgentBusiness,
    ...input.brandNames,
  ])
    assert.ok(
      value && report.toLowerCase().includes(value.toLowerCase()),
      '审核卡未列出官方回执中的列名证据',
    );
  assert.match(report, /(?:申请人|申请企业|Ram\.Shaw)/iu);
  assert.match(report, /GUDID|UDI/iu);
  assert.match(report, /待核实|待确认/u);
  const {
    rows: [reminder],
  } = await pool.query<{ due: string; title: string; jurisdiction_tz: string }>(
    `SELECT to_char(due_on,'MM-DD') AS due,title,jurisdiction_tz FROM timer t JOIN run r ON r.conversation_id=t.conversation_id
      WHERE t.goal_id=$1 AND r.id=$2 AND t.state='active'`,
    [goal, run],
  );
  assert.ok(
    reminder && reminder.due === '12-31' && reminder.jurisdiction_tz === input.jurisdictionTz,
    '未成功登记基于规则包的站内提醒',
  );
  await page.getByRole('button', { name: '查看审核', exact: true }).last().click();
  const card = page.getByRole('article', { name: '审核结果', exact: true });
  await card.getByRole('heading', { name: '审核卡', exact: true }).waitFor();
  assert.match(await card.innerText(), /待核实/u);
  const { rows: cost } = await pool.query<{
    model: string;
    paid: string;
    unknown: number;
    calls: number;
  }>(
    `SELECT model_id AS model,COALESCE(sum(actual_nano) FILTER(WHERE status='settled'),0)::text AS paid,
       count(*) FILTER(WHERE status IN ('unknown','reserved'))::int AS unknown,count(*)::int AS calls
       FROM usage_ledger WHERE run_id=$1 GROUP BY model_id ORDER BY model_id`,
    [run],
  );
  assert.ok(cost.some(({ model }) => model === 'openai/gpt-6.2-astra-pro'));
  return {
    ownerOffline: true,
    review: 'pending',
    official,
    reminder,
    cost: cost.map(({ paid, ...row }) => ({ ...row, usd: nanoToUsd(BigInt(paid)) })),
  };
}
