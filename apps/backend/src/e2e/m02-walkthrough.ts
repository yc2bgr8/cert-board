import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import type pg from 'pg';
import type { Page } from 'playwright-core';
import {
  officialLookupResultSchema,
  reviewEvidenceRefSchema,
  rulePackSeedSchema,
  structuredSubmissionSchema,
  type DocumentCitation,
  type OfficialRecord,
  type ReviewEvidenceRef,
  type StructuredSubmission,
} from '@cert-board/shared';
import { l08PublicCriteria as input } from '../../../../evals/m02/l08-public.js';
import { nanoToUsd } from '../budget/meter.js';
import type { BlobStore } from '../documents/blob-store.js';
import { ingestParsedDocument } from '../documents/service.js';
import { officialRequestUrl } from '../official/providers.js';

const listingFields = {
  company: '列名机构',
  number: '登记号',
  year: '到期年份',
  agent: '美国代理人企业',
  name: '公开列名商品名',
};

function inReviewedReceipt(
  source: DocumentCitation,
  receipt: Pick<DocumentCitation, 'documentId' | 'version' | 'page'>,
  citations: readonly ReviewEvidenceRef[],
) {
  return source.documentId === receipt.documentId && source.version === receipt.version &&
    source.page === receipt.page &&
    citations.some(
      (citation) => citation.documentId === source.documentId && citation.version === source.version &&
        citation.page === source.page && citation.quote === source.quote,
    );
}

function supportsListingField(
  quote: string,
  key: 'company' | 'identifier' | 'registrationExpiryYear' | 'usAgentBusiness' | 'proprietaryNames',
  value: string | number,
  record: OfficialRecord,
) {
  const marker = JSON.stringify(key) + ': ';
  const offset = quote.indexOf(marker);
  if (offset < 0) return false;
  const excerpt = quote.slice(offset + marker.length);
  if (key === 'proprietaryNames') {
    const array = /^\[(?:\s*"(?:\\.|[^"\\])*"\s*,?)*\s*\]/u.exec(excerpt)?.[0];
    if (!array) return false;
    try {
      return JSON.stringify(JSON.parse(array)) === JSON.stringify(record.proprietaryNames);
    } catch {
      return false;
    }
  }
  const literal = JSON.stringify(value);
  return excerpt.startsWith(literal) && /^(?:[\s,}]|$)/u.test(excerpt.slice(literal.length));
}

export function verifyM02ListingClaims(
  listing: OfficialRecord,
  brandNames: readonly string[],
  receipt: Pick<DocumentCitation, 'documentId' | 'version' | 'page'>,
  claims: StructuredSubmission['claims'],
  citations: readonly ReviewEvidenceRef[],
) {
  const names = brandNames.map((name) => {
    const matched = [...new Set(listing.proprietaryNames?.filter((actual) =>
      actual.toLowerCase() === name.toLowerCase(),
    ))];
    assert.equal(matched.length, 1, '无法在列名回执唯一定位本次检索的商品名');
    return matched[0]!;
  });
  for (const [field, key, value] of [
    [listingFields.company, 'company', listing.company],
    [listingFields.number, 'identifier', listing.identifier],
    [listingFields.year, 'registrationExpiryYear', listing.registrationExpiryYear],
    [listingFields.agent, 'usAgentBusiness', listing.usAgentBusiness],
    ...names.map((name) => [listingFields.name, 'proprietaryNames', name] as const),
  ] as const) {
    assert.ok(value !== undefined, '列名回执缺少必须核对的字段');
    const verified = claims.some(
      (claim) => claim.status === 'unverified' && claim.field === field &&
        String(claim.value) === String(value) &&
        claim.sources.some((source) =>
          inReviewedReceipt(source, receipt, citations) && supportsListingField(source.quote, key, value, listing),
        ),
    );
    assert.ok(verified, '审核卡须逐项保留列名回执原值，并引用支持该值的已读档案页');
  }
}

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
      `# L08 公开资料核查\n这是独立验收项目。输入只包含公开的检索条件和合成归档提示。使用 M02。三项查询分别是：fda_registration 同时填写登记号、LRK 与 K 号；fda_registration_company 按申请人全名；fda_gudid_search 填写 LRK、K 号和四个商品全名（按资料列出的顺序）。列名机构、登记号、到期年份、美国代理人企业和每个商品名称分别用一条 unverified claim。field 依次使用“${Object.values(listingFields).join('”“')}”，value 只写回执中的字段原值。逐字引用本次列名档案中字段名及值所在的 JSON 原文，字段依次是 company、identifier、registrationExpiryYear、usAgentBusiness、proprietaryNames。每个商品名引用完整的 proprietaryNames 数组。成功记录需留官方档案，查询不成功如实列项。送审 claims 中，申请人登记用 id=applicant_lookup，公开 UDI 用 id=udi_lookup，两项都引用各自档案，状态用 unverified。观察到成功零条时，该项 value 写“本次查询条件下未查到”；成功返回记录时写“本次查询首批匹配 N 条”，N 按实际首批记录数。登记一项合并的待核实站内提醒，标题包含“年度注册”和“年费”，然后提交审核。`,
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
    const evidence = receipt.evidence;
    assert.ok(
      citations.some(({ documentId, version, page }) =>
        documentId === evidence.documentId && version === evidence.version && page === evidence.page),
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
        claim.sources.some((source) => inReviewedReceipt(source, evidence, citations)),
        `${kind} 结论未引用本次查询档案`,
      );
    }
    return {
      kind,
      documentId: evidence.documentId,
      version: evidence.version,
      page: evidence.page,
      fetchedAt: receipt.fetchedAt,
      matches: receipt.records.length,
      records: receipt.records,
    };
  });
  const listingEvidence = official.find(({ kind }) => kind === 'registration');
  const listing = listingEvidence?.records.find(
    (record) =>
      record.company &&
      record.identifier === input.registrationNumber &&
      record.registrationExpiryYear &&
      record.usAgentBusiness &&
      input.brandNames.every((name) =>
        record.proprietaryNames?.some((actual) => actual.toLowerCase() === name.toLowerCase()),
      ),
  );
  assert.ok(listing && listingEvidence, '列名回执缺少用例所需的登记字段或完整商品名；请核对新公开记录');
  verifyM02ListingClaims(listing, input.brandNames, listingEvidence, submission.claims, citations);
  assert.match(report, /(?:申请人|申请企业|Ram\.Shaw)/iu);
  assert.match(report, /GUDID|UDI/iu);
  assert.ok(submission.uncertain.length > 0, '审核卡必须列出本次核查的不确定事项');
  const { rows: [pinned] } = await pool.query<{ year: string; zone: string; content: unknown }>(
    `SELECT to_char(r.created_at AT TIME ZONE p.jurisdiction_tz,'YYYY') AS year,
       p.jurisdiction_tz AS zone,v.content
     FROM run r JOIN cert_project p ON p.id=r.project_id
     JOIN run_rule_pack used ON used.run_id=r.id
     JOIN rule_pack_version v ON v.id=used.version_id AND v.pack_id=used.pack_id
     JOIN rule_pack pack ON pack.id=used.pack_id AND pack.code='us_fda_m02' WHERE r.id=$1`,
    [run],
  );
  assert.ok(pinned, '定时核查须固定使用本次规则包');
  const end = rulePackSeedSchema.parse(pinned.content).rules
    .find(({ id }) => id === 'annual_registration_window')?.parameters?.window_end;
  assert.ok(end, '本次规则包缺少年度窗口结束日');
  const { rows: reminders } = await pool.query<{ due: string; due_date: string; title: string; jurisdiction_tz: string }>(
    `SELECT to_char(due_on,'MM-DD') AS due,to_char(due_on,'YYYY-MM-DD') AS due_date,title,jurisdiction_tz
      FROM timer t JOIN run r ON r.conversation_id=t.conversation_id
      WHERE t.goal_id=$1 AND r.id=$2 AND t.state='active'`,
    [goal, run],
  );
  assert.equal(reminders.length, 1, '应登记一项合并的站内提醒');
  const [reminder] = reminders;
  assert.ok(
    reminder && reminder.due_date === `${pinned.year}-${end}` &&
      pinned.zone === input.jurisdictionTz && reminder.jurisdiction_tz === pinned.zone,
    '未成功登记基于规则包的站内提醒',
  );
  assert.match(reminder.title, /年度注册/u);
  assert.match(reminder.title, /年费/u);
  const outbound = await pool.query(
    `SELECT 1 FROM tool_invocation WHERE run_id=$1
      AND tool_name IN ('queue_internal_message', 'propose_external') LIMIT 1`,
    [run],
  );
  assert.equal(outbound.rowCount, 0, '定时走查只登记站内提醒，无消息或外发提案');
  await page.getByRole('button', { name: '查看审核', exact: true }).last().click();
  const card = page.getByRole('article', { name: '审核结果', exact: true });
  await card.getByRole('heading', { name: '审核卡', exact: true }).waitFor();
  const uncertainties = card.locator('section').filter({
    has: page.getByRole('heading', { name: '不确定事项', exact: true }),
  });
  for (const item of new Set(submission.uncertain))
    await uncertainties.getByText(item, { exact: true }).waitFor({ state: 'visible' });
  const { rows: cost } = await pool.query<{
    model: string;
    paid: string;
    unknown: number;
    notSent: number;
    calls: number;
  }>(
    `SELECT model_id AS model,COALESCE(sum(actual_nano) FILTER(WHERE status='settled'),0)::text AS paid,
       count(*) FILTER(WHERE status IN ('unknown','reserved'))::int AS unknown,
       count(*) FILTER(WHERE status='not_sent')::int AS "notSent",count(*)::int AS calls
       FROM usage_ledger WHERE run_id=$1 GROUP BY model_id ORDER BY model_id`,
    [run],
  );
  const cursorAcceptance = process.env.CERT_WALKTHROUGH_CURSOR === '1';
  const mainModel = cursorAcceptance ? 'cursor/gpt-5.6-sol' : 'openai/gpt-6.2-astra-pro';
  assert.ok(cost.some(({ model, calls }) => model === mainModel && calls > 0));
  if (cursorAcceptance) {
    assert.deepEqual(cost.map(({ model }) => model), [mainModel]);
    assert.ok(cost.every(({ calls, unknown, notSent, paid }) => calls === unknown + notSent && paid === '0'));
  }
  return {
    mainModel,
    modelTransport: cursorAcceptance ? 'cursor-acp' : 'openrouter',
    ownerOffline: true,
    review: 'pending',
    official,
    reminder,
    cost: cost.map(({ paid, ...row }) => ({ ...row, usd: nanoToUsd(BigInt(paid)) })),
  };
}
