import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import pg from 'pg';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import {
  parseBackendConfig,
  reviewDiffSchema,
  reviewEvidenceRefSchema,
  type PermissionMode,
} from '@cert-board/shared';
import { developmentProjectId } from '../projects/seed.js';
import { nanoToUsd } from '../budget/meter.js';
import { createDependencies } from '../dependencies.js';
import { BlobStore } from '../documents/blob-store.js';
import { requiredRevisionSections, revisionSections } from './walkthrough-report.js';
import { exerciseBatch, maintenancePrompt, registrationPrompt } from './walkthrough-batch.js';
import { checkOfficialBrowserRun } from './official-walkthrough.js';

const maintenanceProjectId = '81c152b6-21ed-496e-824f-f718cc47a101';
const budgetOfWaiting = 16 * 60_000;
let stage = '配置独立走查';

async function installedBrowser() {
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const file of candidates)
    if (
      await access(file).then(
        () => true,
        () => false,
      )
    )
      return file;
  throw new Error('未找到 Chrome 或 Edge。');
}

async function freshConversation(
  page: Page,
  projectId: string,
  title: string,
  permissionMode: PermissionMode,
) {
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新对话', exact: true });
  await dialog.getByRole('textbox', { name: '对话标题', exact: true }).fill(title);
  await dialog.getByRole('combobox', { name: '选择项目', exact: true }).selectOption(projectId);
  await dialog
    .getByRole('combobox', { name: '权限模式', exact: true })
    .selectOption(permissionMode);
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/projects/${projectId}/conversations`,
  );
  await dialog.getByRole('button', { name: '创建对话', exact: true }).click();
  const response = await created;
  assert.equal(response.status(), 200);
  return ((await response.json()) as { conversation: { id: string } }).conversation.id;
}

async function send(page: Page, text: string, button = '发送') {
  await page.getByRole('textbox', { name: '消息', exact: true }).fill(text);
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/conversations\/[^/]+\/(?:messages|answers)$/u.test(new URL(response.url()).pathname),
  );
  await page.getByRole('button', { name: button, exact: true }).click();
  const response = await saved;
  assert.equal(response.status(), 200);
  return (await response.json()) as { runId: string; kind?: string };
}

async function waitForReview(
  page: Page,
  pool: pg.Pool,
  conversationId: string,
  expectedCount: number,
) {
  const until = Date.now() + budgetOfWaiting;
  let lastAnswered: string | null = null;
  while (Date.now() < until) {
    const cards = (
      await pool.query<{ id: string; status: string }>(
        'SELECT id,status FROM review_card WHERE conversation_id=$1 ORDER BY created_at,id',
        [conversationId],
      )
    ).rows;
    if (cards.length >= expectedCount && cards.at(-1)?.status === 'pending') {
      const next = page.getByRole('button', { name: '查看审核', exact: true }).last();
      await next.waitFor({ timeout: 15000 });
      return cards.at(-1)!.id;
    }
    const run = (
      await pool.query<{ id: string; status: string }>(
        'SELECT r.id,r.status FROM conversation c JOIN run r ON r.id=c.current_run_id WHERE c.id=$1',
        [conversationId],
      )
    ).rows[0];
    if (run && ['failed', 'stopped', 'budget_exhausted'].includes(run.status)) {
      console.error(`${stage}出现运行错误。错误编号 ${run.id}`);
      throw new Error('WALKTHROUGH_RUN_STOPPED');
    }
    const approval = page
      .getByRole('region', { name: '批准请求', exact: true })
      .getByRole('button', { name: '允许', exact: true });
    if ((await approval.count()) === 1 && (await approval.isEnabled())) {
      await approval.click();
    } else {
      const answer = page.getByRole('button', { name: '回复', exact: true });
      if (run && run.id !== lastAnswered && (await answer.count()) === 1) {
        await send(
          page,
          '没有额外证据。请把需要确认的事项写入审核卡，依据现有资料完成核查。',
          '回复',
        );
        lastAnswered = run.id;
      }
    }
    await wait(1100);
  }
  throw new Error('WALKTHROUGH_REVIEW_TIMEOUT');
}

async function review(page: Page, pool: pg.Pool, cardId: string, output: string, approve: boolean) {
  await page.getByRole('button', { name: '查看审核', exact: true }).last().click();
  const card = page.getByRole('article', { name: '审核结果', exact: true });
  await card.getByRole('heading', { name: '审核卡', exact: true }).waitFor();
  if (approve) {
    await card.getByRole('button', { name: '通过', exact: true }).click();
    await card.getByText('已通过，工作区版本已冻结。', { exact: true }).waitFor();
    assert.equal(
      (await pool.query('SELECT status FROM review_card WHERE id=$1', [cardId])).rows[0]?.status,
      'approved',
    );
  }
  await page.screenshot({ path: output });
  await page.getByRole('button', { name: '关闭右栏', exact: true }).click();
}

async function inspectSubmission(pool: pg.Pool, cardId: string, skill: 'R09' | 'M02') {
  const { rows } = await pool.query<{ skill_id: string; diff: unknown; evidence_refs: unknown }>(
    "SELECT skill_id,diff,evidence_refs FROM review_card WHERE id=$1 AND status='pending'",
    [cardId],
  );
  const row = rows[0];
  assert.equal(row?.skill_id, skill, '审核卡使用预期技能');
  const evidence = reviewEvidenceRefSchema.array().parse(row?.evidence_refs);
  const { rows: documents } = await pool.query<{ id: string; source_key: string }>(
    'SELECT id,source_key FROM document WHERE id=ANY($1::uuid[])',
    [evidence.map(({ documentId }) => documentId)],
  );
  const keys = new Set(documents.map(({ source_key }) => source_key));
  const expected =
    skill === 'R09' ? ['D035'] : ['PREVIEW-M02-REG', 'PREVIEW-M02-FEE', 'PREVIEW-M02-AGENT'];
  assert.ok(
    expected.every((key) => keys.has(key)),
    '审核卡引用了本案全部预期资料',
  );
  if (skill === 'R09') {
    const checklist = new Set(
      documents.filter(({ source_key }) => source_key === 'D035').map(({ id }) => id),
    );
    assert.ok(
      ['K170825', 'K170285'].every((number) =>
        evidence.some(
          ({ documentId, quote }) => checklist.has(documentId) && quote.includes(number),
        ),
      ),
      '审核卡保留实际的两种编号写法',
    );
  }
  return reviewDiffSchema
    .parse(row?.diff)
    .changes.filter(({ afterSha256 }) => afterSha256 !== null);
}

async function verifyRevision(
  pool: pg.Pool,
  blobs: BlobStore,
  cardId: string,
  original: Awaited<ReturnType<typeof inspectSubmission>>,
) {
  const revised = await inspectSubmission(pool, cardId, 'R09');
  const candidates = revised.flatMap((change) => {
    const old = original.find(({ path }) => path === change.path);
    return change.path.toLowerCase().endsWith('.md') &&
      old?.afterSha256 &&
      change.afterSha256 &&
      old.afterSha256 !== change.afterSha256
      ? [{ before: old.afterSha256, after: change.afterSha256 }]
      : [];
  });
  const reports = await Promise.all(
    candidates.map(async ({ before, after }) => ({
      before: revisionSections(await blobs.get(before)),
      after: revisionSections(await blobs.get(after)),
    })),
  );
  assert.ok(
    reports.some(({ before, after }) =>
      requiredRevisionSections.every(
        (section) => after.has(section) && before.get(section) !== after.get(section),
      ),
    ),
    '原路径报告的核查范围、已核实和待核实三个小节已填写或更新',
  );
}

async function verifyTools(pool: pg.Pool, conversationId: string) {
  const list = (
    await pool.query<{ tool_name: string }>(
      "SELECT DISTINCT tool_name FROM tool_invocation WHERE conversation_id=$1 AND status='completed'",
      [conversationId],
    )
  ).rows.map(({ tool_name }) => tool_name);
  for (const name of ['doc_read', 'skill_load', 'plan_update', 'check_run', 'submit_for_review'])
    assert.ok(list.includes(name), name);
  return list;
}

async function exerciseVerification(
  page: Page,
  pool: pg.Pool,
  evidenceFolder: string,
  onOpened?: (id: string) => void,
) {
  const readyUntil = Date.now() + 30_000;
  let workerReady = false;
  while (Date.now() < readyUntil) {
    const worker = await pool.query(
      "SELECT 1 FROM verification_worker_state WHERE status='ready' AND gateway_ready AND updated_at > NOW() - interval '15 seconds'",
    );
    if (worker.rowCount) {
      workerReady = true;
      break;
    }
    await wait(500);
  }
  assert.ok(workerReady, '外部核实进程必须同时就绪 Cursor 和 OpenRouter');
  await page.getByRole('button', { name: '外部模型', exact: true }).click();
  const group = page.getByRole('region', { name: '外部核实群聊', exact: true });
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/verification/rooms',
  );
  await group
    .getByRole('textbox', { name: '核实问题', exact: true })
    .fill(
      '这是合成走查。两份虚构清单的同一个字段写法不一致，请各位说明核实记录应保留哪些来源字段。没有原文时标为待核实。请勿打开链接或采取对外行动。',
    );
  await group
    .getByRole('combobox', { name: '关联项目', exact: true })
    .selectOption(developmentProjectId);
  await group.getByRole('button', { name: '发起核实', exact: true }).click();
  const opened = await created;
  assert.equal(opened.status(), 200);
  const { id } = (await opened.json()) as { id: string };
  onOpened?.(id);
  let tested: { channel: string; model: string; status: string }[] = [];
  const until = Date.now() + 7 * 60_000;
  while (Date.now() < until) {
    tested = (
      await pool.query<{ channel: string; model: string; status: string }>(
        `SELECT DISTINCT channel,model,status FROM external_model_exchange WHERE conversation_id=$1
       AND dispatched_at IS NOT NULL AND status IN ('settled','unknown') AND returned->>'text' IS NOT NULL`,
        [id],
      )
    ).rows;
    if (
      tested.some((item) => item.channel === 'cursor' && item.model === 'grok-4-7') &&
      tested.some((item) => item.channel === 'gateway' && item.model === 'claude-opus-5-5-gateway')
    )
      break;
    const status = await pool.query<{ state: string }>(
      'SELECT state FROM external_model_conversation WHERE id=$1',
      [id],
    );
    if (['paused', 'completed'].includes(status.rows[0]?.state ?? '')) break;
    await wait(1500);
  }
  assert.ok(tested.some((item) => item.channel === 'cursor' && item.model === 'grok-4-7'));
  assert.ok(
    tested.some((item) => item.channel === 'gateway' && item.model === 'claude-opus-5-5-gateway'),
  );
  const stop = group.getByRole('button', { name: '停止并整理', exact: true });
  if ((await stop.count()) === 1 && (await stop.isEnabled())) await stop.click();
  await group
    .getByRole('complementary', { name: '核实结论', exact: true })
    .waitFor({ timeout: 120000 });
  await page.screenshot({ path: path.join(evidenceFolder, 'verification-v7.png') });
  return { id, channels: tested };
}

export type WalkthroughBatchContext = {
  page: Page;
  browserContext: BrowserContext;
  pool: pg.Pool;
  blobs: BlobStore;
  evidenceFolder: string;
  origin: string;
  blockedRequestCount: () => number;
  registrationProject: string;
  maintenanceProject: string;
  openConversation: typeof freshConversation;
  send: typeof send;
  waitForReview: typeof waitForReview;
  review: typeof review;
  inspectSubmission: typeof inspectSubmission;
  verifyRevision: typeof verifyRevision;
  verifyTools: typeof verifyTools;
  exerciseVerification: typeof exerciseVerification;
};

async function main() {
  const config = parseBackendConfig(process.env);
  assert.equal(config.WEB_ORIGIN, 'http://127.0.0.1:28280');
  const password = process.env.DEV_ZHANGSAN_PASSWORD;
  const evidenceFolder = process.env.CERT_WALKTHROUGH_EVIDENCE_DIR;
  const testedCommit = process.env.CERT_WALKTHROUGH_COMMIT;
  if (!password || !evidenceFolder || !testedCommit) throw new Error('WALKTHROUGH_ENVIRONMENT');
  const startedAt = new Date();
  await mkdir(evidenceFolder, { recursive: true });
  const resources = createDependencies(config);
  const pool = resources.database;
  const blobs = new BlobStore(resources.storage, config.MINIO_BUCKET);
  const browser = await chromium.launch({
    executablePath: await installedBrowser(),
    headless: true,
  });
  try {
    const browserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    let blocked = 0;
    await browserContext.route('**/*', async (route) => {
      const address = new URL(route.request().url());
      if (['http:', 'https:'].includes(address.protocol) && address.origin !== config.WEB_ORIGIN) {
        blocked++;
        await route.abort();
      } else await route.continue();
    });
    const page = await browserContext.newPage();
    stage = '真实浏览器登录';
    const home = await page.goto(config.WEB_ORIGIN);
    const instance = process.env.CERT_WALKTHROUGH_INSTANCE;
    if (process.env.CERT_WALKTHROUGH_DIAGNOSTIC !== '1') {
      assert.ok(instance);
      assert.equal(home?.headers()['x-cert-preview-instance'], instance);
    }
    await page.getByRole('textbox', { name: '账号', exact: true }).fill('zhangsan');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: '新对话', exact: true }).waitFor();
    if (process.env.CERT_WALKTHROUGH_OFFICIAL_ONLY === '1') {
      stage = '官方编号和 V2 的真实浏览器专项';
      const conversation = await freshConversation(page, developmentProjectId, 'L08 官方编号核对', 'full');
      const { runId } = await send(
        page,
        '请在 L08 项目按 R09 做一项编号核对。先读取 D035 中 K170285 的原文，再用 official_lookup 核对公开的 K170825，读取其官方存档中的 identifier 字段，调用 identifier_check（V2）比较。请把两个来源的原文、疑似笔误结论和需要我确认之处存成简短核对说明，并按流程提交审核。不要修改源材料中的编号。',
      );
      const cardId = await waitForReview(page, pool, conversation, 1);
      const proof = await checkOfficialBrowserRun(page, pool, runId, cardId, evidenceFolder);
      assert.equal(blocked, 0);
      await writeFile(
        path.join(evidenceFolder, 'official-result.json'),
        JSON.stringify({ ...proof, status: 'passed', instance, commit: testedCommit }, null, 2),
        'utf8',
      );
      console.log('官方编号与 V2 真实浏览器验收通过。');
      return;
    }
    if (process.env.CERT_WALKTHROUGH_BATCH === '1') {
      stage = '多场真实对话走查';
      await exerciseBatch({
        page,
        browserContext,
        pool,
        blobs,
        evidenceFolder,
        origin: config.WEB_ORIGIN,
        blockedRequestCount: () => blocked,
        registrationProject: developmentProjectId,
        maintenanceProject: maintenanceProjectId,
        openConversation: freshConversation,
        send,
        waitForReview,
        review,
        inspectSubmission,
        verifyRevision,
        verifyTools,
        exerciseVerification,
      });
      return;
    }
    if (
      process.env.CERT_WALKTHROUGH_DIAGNOSTIC === '1' &&
      process.env.CERT_WALKTHROUGH_VERIFICATION_ONLY === '1'
    ) {
      stage = '单独诊断 v7 的两条真实核实通道';
      await freshConversation(
        page,
        developmentProjectId,
        '双通道诊断的项目计量上下文',
        'read_only',
      );
      const verified = await exerciseVerification(page, pool, evidenceFolder);
      await writeFile(
        path.join(evidenceFolder, 'verification-result.json'),
        JSON.stringify(verified, null, 2),
        'utf8',
      );
      console.log(`核实通道诊断完成。记录在 ${evidenceFolder}。`);
      return;
    }
    stage = '真实 R09 首次送审';
    const registration = await freshConversation(page, developmentProjectId, 'R09 真实走查', 'ask');
    await send(page, registrationPrompt);
    const original = await waitForReview(page, pool, registration, 1);
    const firstReport = await inspectSubmission(pool, original, 'R09');
    await review(page, pool, original, path.join(evidenceFolder, 'r09-first-review.png'), false);
    stage = '真实 R09 修改重提和人工通过';
    await send(
      page,
      '请修改原路径的 Markdown 报告，新增或更新“核查范围”“已核实”“待核实”三个带 Markdown 标题的小节。各小节都补实质内容，然后保存并重新提交审核。',
    );
    const revised = await waitForReview(page, pool, registration, 2);
    await verifyRevision(pool, blobs, revised, firstReport);
    await review(page, pool, revised, path.join(evidenceFolder, 'r09-approved.png'), true);
    const registrationTools = await verifyTools(pool, registration);

    stage = '真实 M02 维护核查';
    const maintenance = await freshConversation(page, maintenanceProjectId, 'M02 真实走查', 'full');
    await send(page, maintenancePrompt);
    const maintenanceReview = await waitForReview(page, pool, maintenance, 1);
    await inspectSubmission(pool, maintenanceReview, 'M02');
    await review(
      page,
      pool,
      maintenanceReview,
      path.join(evidenceFolder, 'm02-reviewed.png'),
      true,
    );
    const maintenanceTools = await verifyTools(pool, maintenance);

    let errorId: string | null = null;
    let verification: Awaited<ReturnType<typeof exerciseVerification>> | null = null;
    if (process.env.CERT_WALKTHROUGH_DIAGNOSTIC !== '1') {
      stage = '真实核实验证 Cursor 与 OpenRouter 两条通道';
      verification = await exerciseVerification(page, pool, evidenceFolder);
      stage = '错误编号与日志关联';
      await page.goto(`${config.WEB_ORIGIN}/?conversation=${randomUUID()}`);
      const failure = page.getByRole('alert').filter({ hasText: /错误编号/u });
      await failure.waitFor({ timeout: 20000 });
      errorId = (await failure.textContent())?.match(/错误编号 ([0-9a-f-]{36})/iu)?.[1] ?? null;
      assert.ok(errorId);
      const log = await readFile(path.resolve('.local/preview/walkthrough/api.log'), 'utf8');
      assert.ok(
        log
          .split(/\r?\n/u)
          .some((line) => line.includes(errorId!) && line.includes('request_failed')),
      );
      await page.screenshot({ path: path.join(evidenceFolder, 'error-number.png') });
    }
    stage = '只读汇总真实模型与费用';
    const settledUntil = Date.now() + 120000;
    while (Date.now() < settledUntil) {
      const active = await pool.query(
        `SELECT 1 FROM run WHERE conversation_id=ANY($1::uuid[]) AND status IN ('queued','running') LIMIT 1`,
        [[registration, maintenance]],
      );
      if (!active.rowCount) break;
      await wait(1000);
    }
    const cost = (
      await pool.query<{ model: string; paid: string; unknown: number; calls: number }>(
        `SELECT model_id AS model,COALESCE(sum(actual_nano) FILTER(WHERE status='settled'),0)::text AS paid,
       count(*) FILTER(WHERE status IN ('unknown','reserved'))::int AS unknown,count(*)::int AS calls
       FROM usage_ledger WHERE created_at>=$1 GROUP BY model_id ORDER BY model_id`,
        [startedAt],
      )
    ).rows;
    assert.ok(cost.some(({ model }) => model === 'openai/gpt-6.2-astra-pro'));
    assert.equal(blocked, 0);
    const proof = {
      status: 'passed',
      commit: testedCommit,
      instance,
      errorId,
      verification,
      registration: {
        url: `${config.WEB_ORIGIN}/?conversation=${registration}`,
        tools: registrationTools,
      },
      maintenance: {
        url: `${config.WEB_ORIGIN}/?conversation=${maintenance}`,
        tools: maintenanceTools,
      },
      cost: cost.map(({ paid, ...row }) => ({ ...row, usd: nanoToUsd(BigInt(paid)) })),
    };
    await writeFile(
      path.join(evidenceFolder, 'result.json'),
      JSON.stringify(proof, null, 2),
      'utf8',
    );
    console.log(`真实浏览器走查完成。记录在 ${evidenceFolder}。`);
  } finally {
    await browser.close();
    await resources.close();
  }
}

main().catch(() => {
  console.error(`真实走查未通过。阶段为${stage}，原对话保留在独立走查环境中。`);
  process.exitCode = 1;
});
