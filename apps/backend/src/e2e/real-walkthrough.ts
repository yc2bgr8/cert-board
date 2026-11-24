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
import { checkRulesBrowserRun } from './rules-walkthrough.js';
import { checkKnowledgeWalkthrough } from './knowledge-walkthrough.js';
import { cursorProbeDoc, prepareCursorProbe } from './cursor-probe.js';
import {
  inspectM02Walkthrough,
  prepareM02Walkthrough,
  waitForM02OfflineReview,
} from './m02-walkthrough.js';
import { checkR09PackageReadOnly, checkR09Revision, r09Replacements, readOnlyWorkspaceSnapshot } from './r09-walkthrough.js';

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
  onUnsubmitted?: () => Promise<void>,
) {
  const until = Date.now() + budgetOfWaiting;
  let lastAnswered: string | null = null;
  let continued = false;
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
      if (run.status === 'stopped' && onUnsubmitted && !continued) {
        const { rows: [last] } = await pool.query<{ reason: string | null }>(
          `SELECT payload_json->>'reasonCode' AS reason FROM conversation_event
           WHERE run_id=$1 AND type='run_status' ORDER BY seq DESC LIMIT 1`,
          [run.id],
        );
        if (last?.reason === 'REVIEW_NOT_SUBMITTED') {
          continued = true;
          await onUnsubmitted();
          continue;
        }
      }
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

async function review(page: Page, pool: pg.Pool, cardId: string, output: string, approve: boolean, pendingReport?: string) {
  await page.getByRole('button', { name: '查看审核', exact: true }).last().click();
  const card = page.getByRole('article', { name: '审核结果', exact: true });
  await card.getByRole('heading', { name: '审核卡', exact: true }).waitFor();
  if (pendingReport) {
    const complete = card.locator('details').filter({ hasText: '完整待批改动' });
    await complete.locator('summary').click();
    await complete.getByText(pendingReport, { exact: true }).waitFor();
    await page.screenshot({ path: path.join(path.dirname(output), 'r09-complete-diff.png') });
  }
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
  const cursorAcceptance = process.env.CERT_WALKTHROUGH_CURSOR === '1';
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
  assert.ok(workerReady, '外部核实进程必须同时就绪 Cursor 与模型网关');
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
  if (cursorAcceptance) {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM external_model_exchange e JOIN usage_ledger u ON u.request_key=e.id
       WHERE e.conversation_id=$1 AND e.channel='gateway' AND e.returned->>'text' IS NOT NULL
       AND u.model_id='cursor/claude-opus-5.5' AND u.status='unknown' AND e.status='unknown'`, [id],
    );
    assert.ok(rowCount, '验收时网关核实须来自 Cursor 的 Claude Opus 5.5');
  }
  const stop = group.getByRole('button', { name: '停止并整理', exact: true });
  if ((await stop.count()) === 1 && (await stop.isEnabled())) await stop.click();
  await group
    .getByRole('complementary', { name: '核实结论', exact: true })
    .waitFor({ timeout: 120000 });
  await page.screenshot({ path: path.join(evidenceFolder, 'verification-v7.png') });
  return { id, channels: tested, gatewayTransport: cursorAcceptance ? 'cursor-acp' : 'openrouter' };
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
    const login = async () => {
      await page.getByRole('textbox', { name: '账号', exact: true }).fill('zhangsan');
      await page.getByLabel('密码', { exact: true }).fill(password);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page.getByRole('button', { name: '新对话', exact: true }).waitFor();
    };
    await login();
    if (process.env.CERT_WALKTHROUGH_CURSOR_PROBE === '1') {
      assert.equal(process.env.CERT_WALKTHROUGH_CURSOR, '1');
      stage = 'Cursor 合成项目工具与浏览器审核';
      const project = await prepareCursorProbe(pool, blobs);
      await page.reload();
      const conversation = await freshConversation(page, project, '合成对比编号核查', 'full');
      await send(page, [
        `只使用本项目合成资料 ${cursorProbeDoc} 的两页，用 R09 核对对比器械 K 号的写法。不要查外网。`,
        '实际调用工具，先加载技能、列计划并检索资料，再逐页读取。两页分别引用原句，保留待核实结论。',
        '请用工具将报告保存到「交付/合成编号核查.md」，保存工作区版本，运行 check_run，再调用 submit_for_review 生成审核卡。以审核卡为交付。',
      ].join('\n'));
      let continuedAfterText = false;
      const cardId = await waitForReview(page, pool, conversation, 1, async () => {
        continuedAfterText = true;
        await send(page, `刚才还没有审核卡。请继续合成任务，重新逐页读取 ${cursorProbeDoc} 的两页，使用工具保存报告、运行 check_run 并实际调用 submit_for_review。`);
      });
      const evidence = await pool.query<{ pages: number }>(
        `SELECT count(DISTINCT entry->>'page')::int AS pages
         FROM review_card r CROSS JOIN LATERAL jsonb_array_elements(r.evidence_refs) entry
         JOIN document d ON d.id=(entry->>'documentId')::uuid
         WHERE r.id=$1 AND r.skill_id='R09' AND d.project_id=$2 AND d.source_key=$3`,
        [cardId,project,cursorProbeDoc],
      );
      assert.equal(evidence.rows[0]?.pages, 2);
      const tools = await verifyTools(pool, conversation);
      const models = await pool.query<{ model: string }>(
        `SELECT DISTINCT u.model_id AS model FROM usage_ledger u JOIN run r ON r.id=u.run_id
         WHERE r.conversation_id=$1 AND u.purpose='agent'`, [conversation],
      );
      assert.deepEqual(models.rows.map(({model}) => model), ['cursor/gpt-5.6-sol']);
      await review(page, pool, cardId, path.join(evidenceFolder, 'cursor-synthetic-review.png'), true);
      assert.equal(blocked, 0);
      await writeFile(path.join(evidenceFolder, 'cursor-probe.json'), JSON.stringify({
        status:'passed', instance, commit: testedCommit, synthetic:true, continuedAfterText, routesBlocked:blocked,
        modelTransport:'cursor-acp', mainModel:'cursor/gpt-5.6-sol', tools, evidencePages:2,
      }, null, 2), 'utf8');
      console.log('Cursor 合成项目的实际工具调用、引用与浏览器审核通过。');
      return;
    }
    if (process.env.CERT_WALKTHROUGH_M02_ONLY === '1') {
      stage = '维护负责人在工作目标中启用 M02 定时核查';
      const sample = await prepareM02Walkthrough(pool, blobs);
      await page.reload();
      const openProject = async () => {
        await page.getByRole('button', { name: '维护Agent', exact: true }).click();
        await page.getByRole('button', { name: sample.name, exact: true }).click();
      };
      await openProject();
      await page.getByRole('button', { name: '启用定时核查', exact: true }).click();
      await page.getByRole('button', { name: '停用定时核查', exact: true }).waitFor();
      await page.screenshot({ path: path.join(evidenceFolder, 'm02-schedule.png') });
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('button', { name: '退出登录', exact: true }).click();
      await page.getByRole('button', { name: '登录', exact: true }).waitFor();
      await pool.query(
        "UPDATE run SET status='completed',finished_at=clock_timestamp() WHERE id=$1",
        [sample.blocker],
      );
      stage = '负责人离线时，后台按月或年度窗口启动 M02 并送审';
      const result = await waitForM02OfflineReview(pool, sample.goal, startedAt);
      stage = '负责人返回后在工作台查看待审核查结果';
      await login();
      await page.goto(`${config.WEB_ORIGIN}/?conversation=${result.conversation}`);
      const proof = await inspectM02Walkthrough(page, pool, sample.goal, result.run, result.card);
      await page.screenshot({ path: path.join(evidenceFolder, 'm02-review.png') });
      await page.goto(config.WEB_ORIGIN);
      await openProject();
      await page.getByRole('button', { name: '停用定时核查', exact: true }).click();
      await page.getByRole('button', { name: '启用定时核查', exact: true }).waitFor();
      assert.equal(blocked, 0);
      await writeFile(
        path.join(evidenceFolder, 'm02-result.json'),
        JSON.stringify({ ...proof, status: 'passed', instance, commit: testedCommit }, null, 2),
        'utf8',
      );
      console.log('M02 官方资料、负责人离线唤醒、站内提醒与浏览器送审专项通过。');
      return;
    }
    if (process.env.CERT_WALKTHROUGH_KNOWLEDGE_ONLY === '1') {
      stage = '维护 Agent 读取规则包并记录运行版本';
      await page.getByRole('button', { name: '维护Agent', exact: true }).click();
      const conversation = await freshConversation(page, maintenanceProjectId, 'M02 规则包版本核查', 'read_only');
      const { runId } = await send(page,
        '请调用 knowledge_get 读取规则包 us_fda_m02，以回执为依据核对年度注册窗口、该财年企业年费和一间境外机构可指定的美国代理人数。最终只输出 JSON 对象 {"版本":"","状态":"","开始":"MM-DD","结束":"MM-DD","财年":0,"金额":0,"币种":"","代理人数":0,"来源":["","",""]}。状态请选择“待注册人员确认”“已确认”或“待核”。来源写这三个条目各自的 source.url。只读核查，不保存或提交。',
      );
      const proof = await checkKnowledgeWalkthrough(page, pool, runId, conversation);
      assert.equal(blocked, 0);
      await writeFile(path.join(evidenceFolder, 'knowledge-result.json'), JSON.stringify({ ...proof, status: 'passed', instance, commit: testedCommit }, null, 2), 'utf8');
      console.log('事实与规则包真实浏览器验收通过。');
      return;
    }
    if (process.env.CERT_WALKTHROUGH_R09_ONLY === '1') {
      stage = 'R09 的原文核验和双修改浏览器专项';
      const reportPath = `交付/R09-双修改走查-${randomUUID().slice(0, 8)}.md`;
      const conversation = await freshConversation(page, developmentProjectId, 'R09 两处意见复验', 'full');
      await send(page, `${registrationPrompt} 报告使用 ${reportPath}。请分别原样保留这两行，供下一轮修改验证：\n${r09Replacements.map(([initial]) => initial).join('\n')}`);
      const original = await waitForReview(page, pool, conversation, 1);
      await inspectSubmission(pool, original, 'R09');
      await review(page, pool, original, path.join(evidenceFolder, 'r09-eval-initial.png'), false);
      await send(page, `请修改原路径 ${reportPath}。只应用两条明确意见，其他行保持原样，保存并重新提交审核。\n${r09Replacements.map(([before, after], index) => `${index + 1}. 把「${before}」替换为「${after}」`).join('\n')}`);
      const revised = await waitForReview(page, pool, conversation, 2);
      await inspectSubmission(pool, revised, 'R09');
      const proof = await checkR09Revision(pool, blobs, original, revised, conversation, reportPath);
      await review(page, pool, revised, path.join(evidenceFolder, 'r09-eval-approved.png'), true, reportPath);
      const { rows: [approval] } = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM review_card WHERE conversation_id=$1 AND status='approved'",
        [conversation],
      );
      const approvedCards = approval?.count;
      assert.equal(approvedCards, 1, '改稿对话应只通过重提后的审核卡。');
      stage = 'R09 整包候选复判的只读浏览器专项';
      const readOnly = await freshConversation(page, developmentProjectId, 'R09 整包候选复判', 'read_only');
      const workspaceBefore = await readOnlyWorkspaceSnapshot(pool, developmentProjectId, readOnly);
      const { runId } = await send(page,
        '按 R09 只读检查 L08。先运行 rules_run 的 R3、R5，再读取 D021 第29页与 D023 第17页判断各自用水动作。最终回复只返回一个 JSON 对象，字段格式为 {"用水证据":[{"资料编号":"","页码":1,"用途":"","原文":""}],"MSDS":{"资料编号":"","页码":1,"状态":"","缺失":""}}。用水证据填两项，“用途”各从“冲洗”“冷却”“待核”选择，“原文”逐字摘录英文，包含该动作和含单位的温度范围。MSDS 的资料编号及页码用 R5 回执里的实际定位。“状态”从“待核证据”“已证实差异”“无缺件”选择。“缺失”从“实际附件”“第二处独立证据”“无缺件”“待核信息”选择。所有字段填入证据支持的值。不要保存或提交。',
      );
      const packageProof = await checkR09PackageReadOnly(page, pool, runId, readOnly);
      assert.deepEqual(
        await readOnlyWorkspaceSnapshot(pool, developmentProjectId, readOnly),
        workspaceBefore,
        '只读整包核查应保留工作区版本及工作副本。',
      );
      assert.equal(blocked, 0);
      await writeFile(
        path.join(evidenceFolder, 'r09-result.json'),
        JSON.stringify({ ...proof, packageProof: { ...packageProof, workspaceUnchanged: true }, status: 'passed', instance, commit: testedCommit, approvedInBrowser: true, approvedCards }, null, 2),
        'utf8',
      );
      console.log('R09 原文、两处改稿和浏览器批准专项通过。');
      return;
    }
    if (process.env.CERT_WALKTHROUGH_RULES_ONLY === '1') {
      stage = '一致性规则库的真实浏览器专项';
      const conversation = await freshConversation(page, developmentProjectId, 'L08 一致性规则核对', 'full');
      const { runId } = await send(
        page,
        '请按 R09 对 L08 资料运行 rules_run 的 R1 和 R5，报告候选编号差异和 eSTAR 附件引用疑点。核实 D035 的编号原文并按规则回执引用实际资料，附件疑点待我核实。保存简短说明，按正常流程提交审核并保留原件原样。',
      );
      const cardId = await waitForReview(page, pool, conversation, 1);
      const proof = await checkRulesBrowserRun(page, pool, runId, cardId);
      await review(page, pool, cardId, path.join(evidenceFolder, 'rules-approved.png'), true);
      assert.equal(blocked, 0);
      await writeFile(
        path.join(evidenceFolder, 'rules-result.json'),
        JSON.stringify({ ...proof, status: 'passed', instance, commit: testedCommit, approvedInBrowser: true }, null, 2),
        'utf8',
      );
      console.log('一致性规则库真实浏览器验收通过。');
      return;
    }
    if (process.env.CERT_WALKTHROUGH_OFFICIAL_ONLY === '1') {
      stage = '官方编号和 V2 的真实浏览器专项';
      const conversation = await freshConversation(page, developmentProjectId, 'L08 官方编号核对', 'full');
      const { runId } = await send(
        page,
        '请在 L08 项目按 R09 做一项编号核对。先读取 D035 中 K170285 的原文，再用 official_lookup 核对公开的 K170825，读取其官方存档中的 identifier 字段，调用 identifier_check（V2）比较。请保存简短说明并送审。审核卡结论首句用格式「编号核对：材料 [材料编号]，官方 [官方编号]，差异 [差异]，状态 [状态]。」，差异填写一致、疑似笔误或其他差异，状态填写待确认或已核实。按实际证据填值，引用两个来源的原文，保留源材料原样。',
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
      stage = '真实核实验证 Cursor 与模型网关两条应用通道';
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
      await pool.query<{ model: string; paid: string; unknown: number; notSent: number; calls: number }>(
        `SELECT model_id AS model,COALESCE(sum(actual_nano) FILTER(WHERE status='settled'),0)::text AS paid,
       count(*) FILTER(WHERE status IN ('unknown','reserved'))::int AS unknown,
       count(*) FILTER(WHERE status='not_sent')::int AS "notSent",count(*)::int AS calls
       FROM usage_ledger WHERE created_at>=$1 GROUP BY model_id ORDER BY model_id`,
        [startedAt],
      )
    ).rows;
    const cursorAcceptance = process.env.CERT_WALKTHROUGH_CURSOR === '1';
    const mainModel = cursorAcceptance ? 'cursor/gpt-5.6-sol' : 'openai/gpt-6.2-astra-pro';
    assert.ok(cost.some(({ model, calls }) => model === mainModel && calls > 0));
    if (cursorAcceptance) {
      assert.ok(cost.every(({ calls, unknown, notSent, paid }) => calls === unknown + notSent && paid === '0'));
      for (const conversationId of [registration, maintenance]) {
        const { rows } = await pool.query<{ model: string }>(
          `SELECT DISTINCT u.model_id AS model FROM usage_ledger u JOIN run r ON r.id=u.run_id
           WHERE r.conversation_id=$1 AND u.purpose='agent'`, [conversationId],
        );
        assert.deepEqual(rows.map(({ model }) => model), [mainModel]);
      }
    }
    assert.equal(blocked, 0);
    const proof = {
      status: 'passed',
      commit: testedCommit,
      instance,
      mainModel,
      modelTransport: cursorAcceptance ? 'cursor-acp' : 'openrouter',
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
