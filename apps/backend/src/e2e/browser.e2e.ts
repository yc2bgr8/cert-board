import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  type Response,
} from 'playwright-core';
import { startBrowserHarness } from '../test-support/browser-harness.js';
import { reviewBrowserFlow } from '../test-support/browser-review-flow.js';
import { calculateDeadline } from '../deadlines/calendar.js';
import { scanDeadlineReminders } from '../deadlines/scan.js';
import { processTestOutbound } from '../outbound/service.js';
import { developmentGoalId } from '../projects/seed.js';
import { parseSkillDraftMarkdown } from '../skills/markdown.js';
import { stageSkillVersion } from '../skills/service.js';
import {
  browserReviewPath,
  browserVerificationUncertainty,
} from '../test-support/browser-review-fixture.js';

let stage = '启动';
async function until(check: () => boolean | Promise<boolean>, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('BROWSER_CHECK_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
async function bounded<T>(promise: Promise<T>, timeout = 20000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('BROWSER_CHECK_TIMEOUT')), timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function captureWorkbench(page: Page, output: string, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.screenshot({ path: path.join(output, name), fullPage: true });
}
async function checkNarrowLayout(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  const overflow = await page.evaluate(() =>
    [
      document.documentElement,
      ...Array.from(document.querySelectorAll('.live-shell,.live-new-dialog,.live-search-dialog')),
    ]
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => ({
        name: element.className || element.tagName,
        width: element.clientWidth,
        content: element.scrollWidth,
      })),
  );
  if (overflow.length) console.error('窄屏布局尺寸', JSON.stringify(overflow));
  assert.equal(overflow.length, 0);
  await page.setViewportSize({ width: 1440, height: 900 });
}
async function browserPath() {
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* 只使用已安装浏览器。 */
    }
  }
  throw new Error('BROWSER_BINARY_MISSING');
}
async function createConversation(
  page: Page,
  projectId: string,
  mode?: 'ask' | 'read_only' | 'full',
  title?: string,
  firstMessage?: string,
) {
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新对话', exact: true });
  if (title) await dialog.getByRole('textbox', { name: '对话标题', exact: true }).fill(title);
  await dialog.getByRole('combobox', { name: '选择项目', exact: true }).selectOption(projectId);
  if (firstMessage)
    await dialog.getByRole('textbox', { name: '首条消息', exact: true }).fill(firstMessage);
  if (mode)
    await dialog.getByRole('combobox', { name: '权限模式', exact: true }).selectOption(mode);
  else
    assert.equal(
      await dialog.getByRole('combobox', { name: '权限模式', exact: true }).inputValue(),
      'full',
    );
  const request = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/conversations$/.test(new URL(response.url()).pathname),
  );
  await dialog.getByRole('button', { name: '创建对话', exact: true }).click();
  const response = await request;
  assert.equal(response.status(), 200);
  const value = (await response.json()) as { conversation: { id: string; permissionMode: string } };
  assert.equal(value.conversation.permissionMode, mode ?? 'full');
  return value.conversation.id;
}
async function send(page: Page, text: string, action = '发送') {
  await page.getByRole('textbox', { name: '消息', exact: true }).fill(text);
  const request = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/messages$/.test(new URL(response.url()).pathname),
  );
  await page.getByRole('button', { name: action, exact: true }).click();
  const response = await request;
  assert.equal(response.status(), 200);
  return (await response.json()) as { runId: string; kind: string };
}

async function main() {
  const harness = await startBrowserHarness();
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let authenticated = false;
  const output = path.resolve('.local', 'e2e');
  try {
    browser = await chromium.launch({ executablePath: await browserPath(), headless: true });
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      serviceWorkers: 'block',
    });
    let externalRequests = 0;
    let fixtureImages = 0;
    let fixtureImageWithReferrer = false;
    let markdownScriptRequests = 0;
    await context.route('**/*', async (route) => {
      const request = route.request();
      if (
        request.url() === 'https://external.invalid/fixture-image.svg' &&
        request.resourceType() === 'image'
      ) {
        fixtureImages++;
        fixtureImageWithReferrer ||= Boolean(await request.headerValue('referer'));
        await route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="154" height="64"><rect width="154" height="64" rx="8" fill="#eaf5f1"/><text x="76" y="37" text-anchor="middle" fill="#146b62" font-size="13">浏览器测试图片</text></svg>',
        });
      } else if (request.url() === `${harness.origin}/assets/markdown-fixture.js`) {
        markdownScriptRequests++;
        await route.abort();
      } else if (new URL(request.url()).origin !== harness.origin) {
        externalRequests++;
        await route.abort();
      } else await route.continue();
    });
    page = await context.newPage();
    await mkdir(output, { recursive: true });
    page.setDefaultTimeout(15000);
    let pageErrors = 0;
    let priorCspViolations = 0;
    const priorCspDirectives = new Set<string>();
    page.on('pageerror', () => {
      pageErrors++;
    });
    await page.addInitScript(() => {
      Object.assign(globalThis, {
        __certInjected: false,
        __certCspViolations: 0,
        __certCspDirectives: [],
      });
      globalThis.addEventListener('securitypolicyviolation', (event) => {
        const state = globalThis as typeof globalThis & {
          __certCspViolations: number;
          __certCspDirectives: string[];
        };
        state.__certCspViolations++;
        const directive = (event as SecurityPolicyViolationEvent).effectiveDirective;
        if (
          /^(?:default|script|style|img|font|connect|object|frame|base|form)-[a-z-]+$/.test(
            directive,
          )
        )
          state.__certCspDirectives.push(directive);
      });
    });
    stage = '真实登录';
    const navigation = await page.goto(harness.origin);
    const csp = navigation?.headers()['content-security-policy'] ?? '';
    assert.ok(
      csp.includes("default-src 'self'") &&
        csp.includes("style-src 'self' 'unsafe-inline'") &&
        csp.includes("img-src 'self' https: data: blob:") &&
        csp.includes("connect-src 'self'"),
    );
    assert.equal(
      csp.split('; ').find((directive) => directive.startsWith('script-src')),
      "script-src 'self'",
    );
    assert.equal(csp.includes('unsafe-eval'), false);
    assert.equal(navigation?.headers()['referrer-policy'], 'no-referrer');
    await page.getByRole('textbox', { name: '账号', exact: true }).waitFor();
    await captureWorkbench(page, output, 'pr-u1-01-login.png');
    assert.equal(
      await page.evaluate(async () =>
        (await document.fonts.load('400 14px Inter')).some(
          (font) => font.family === 'Inter' && font.status === 'loaded',
        ),
      ),
      true,
    );
    // 密码只在内存中交给浏览器，不启用trace/HAR；登录失败不传播含fill参数的异常。
    try {
      await page
        .getByRole('textbox', { name: '账号', exact: true })
        .fill(harness.credentials.username);
      await page.getByLabel('密码', { exact: true }).fill(harness.credentials.password);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page.getByRole('button', { name: 'L08 510(k)', exact: true }).waitFor();
    } catch {
      throw new Error('BROWSER_LOGIN_FAILED');
    }
    authenticated = true;
    const cookie = (await context.cookies()).find((value) => value.name === 'cert_board_session');
    assert.equal(cookie?.httpOnly, true);
    assert.equal(cookie?.sameSite, 'Strict');
    stage = '新版外框、助手与新对话';
    await page.getByRole('button', { name: '维护Agent', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'L08 510(k)', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '外部模型', exact: true }).count(), 1);
    await page.getByRole('button', { name: '注册Agent', exact: true }).click();
    await page.getByRole('button', { name: '新对话', exact: true }).click();
    const newDialog = page.getByRole('dialog', { name: '新对话', exact: true });
    await newDialog
      .getByRole('textbox', { name: '对话标题', exact: true })
      .fill('检查L08申报包，列出缺件和前后不一致的地方，各附两处原文');
    await newDialog.getByRole('textbox', { name: '对话标题', exact: true }).blur();
    assert.equal(
      await newDialog.getByRole('radio', { name: '注册Agent', exact: true }).isChecked(),
      true,
    );
    await captureWorkbench(page, output, 'pr-u1-02-new-conversation.png');
    await checkNarrowLayout(page);
    await page.setViewportSize({ width: 1000, height: 900 });
    const narrowTitle = newDialog.getByRole('textbox', { name: '对话标题', exact: true });
    const originalTitle = await narrowTitle.inputValue();
    await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
    await page.getByRole('complementary', { name: '项目导航', exact: true }).waitFor();
    assert.equal(await narrowTitle.inputValue(), originalTitle);
    await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
    assert.equal(await narrowTitle.inputValue(), originalTitle);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.keyboard.press('Escape');
    await newDialog.waitFor({ state: 'hidden' });
    stage = '新对话默认完全允许';
    const firstMessage = '首条消息等待人工确认后发送。';
    const editedDraft = '编辑过的首条消息，稍后发送。';
    const draftConversation = await createConversation(
      page,
      harness.projectId,
      undefined,
      'K123465 写法检查',
      firstMessage,
    );
    assert.equal(
      await page.getByRole('textbox', { name: '消息', exact: true }).inputValue(),
      firstMessage,
    );
    assert.equal(
      (await harness.pool.query('SELECT id FROM run WHERE conversation_id=$1', [draftConversation]))
        .rowCount,
      0,
    );
    await page.getByRole('textbox', { name: '消息', exact: true }).fill(editedDraft);
    stage = '新版搜索';
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    const searchDialog = page.getByRole('dialog', { name: '搜索项目或对话', exact: true });
    const searchBox = searchDialog.getByRole('combobox', { name: '搜索项目或对话', exact: true });
    await searchBox.fill('K123465');
    await searchDialog.getByRole('option', { name: /K123465.*写法检查/ }).waitFor();
    await captureWorkbench(page, output, 'pr-u1-13-search.png');
    await checkNarrowLayout(page);
    await searchBox.fill('510(k)');
    const projectOption = searchDialog.getByRole('option', { name: 'L08 510(k)', exact: true });
    await projectOption.waitFor();
    await searchBox.press('ArrowUp');
    assert.equal(await projectOption.getAttribute('aria-selected'), 'true');
    assert.equal(
      await searchBox.getAttribute('aria-activedescendant'),
      await projectOption.getAttribute('id'),
    );
    await searchBox.press('Enter');
    await searchDialog.waitFor({ state: 'hidden' });
    await page.getByRole('heading', { name: 'L08 510(k)', exact: true }).waitFor();
    stage = 'L08资料与安全Markdown';
    await createConversation(page, harness.projectId, 'read_only');
    await page.getByRole('button', { name: '添加资料引用', exact: true }).click();
    await page
      .getByRole('region', { name: '添加资料引用', exact: true })
      .getByRole('button', { name: /D035/ })
      .click();
    assert.match(
      await page.getByRole('textbox', { name: '消息', exact: true }).inputValue(),
      /资料引用：D035/,
    );
    const read = harness.plan('read');
    const first = await send(page, '只读检查L08对比器械资料，说明原文位置。');
    await page.getByText('已读取资料原文，正确编号仍待确认。', { exact: false }).waitFor();
    await until(() => read.observed.calls === 3);
    assert.equal(read.observed.readPage, 1);
    await page
      .getByText(/^工具过程/)
      .first()
      .click();
    await page
      .getByText(/读取资料原文/)
      .last()
      .waitFor();
    assert.equal(
      await page.locator('[data-markdown-sample="html"]').textContent(),
      'HTML 样例内容',
    );
    await page.getByRole('table').waitFor();
    assert.equal(await page.locator('code.hljs').count(), 1);
    assert.equal(
      await page.locator('style[data-probe="stylesheet"], link[href$="/blocked.css"]').count(),
      0,
    );
    assert.equal(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--fixture-global-style'),
      ),
      '',
    );
    const image = page.getByRole('img', { name: '外部图片', exact: true });
    await image.scrollIntoViewIfNeeded();
    await until(() =>
      image.evaluate((element) => (element as HTMLImageElement).naturalWidth === 154),
    );
    assert.equal(
      await page.evaluate(
        () => (globalThis as typeof globalThis & { __certInjected: boolean }).__certInjected,
      ),
      false,
    );
    stage = 'Markdown 图片隐私和内容脚本隔离';
    if (fixtureImageWithReferrer) throw new Error('BROWSER_IMAGE_REFERRER_PRESENT');
    if (markdownScriptRequests !== 0) throw new Error('BROWSER_MARKDOWN_SCRIPT_REQUESTED');
    const externalLink = page.getByRole('link', { name: /外部参考/ });
    assert.equal(await externalLink.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(await externalLink.getAttribute('target'), '_blank');
    await page.screenshot({ path: path.join(output, 'conversation-read.png'), fullPage: true });
    await captureWorkbench(page, output, 'pr-u2-markdown.png');
    await until(
      async () =>
        (await harness.pool.query('SELECT status FROM run WHERE id=$1', [first.runId])).rows[0]
          ?.status === 'completed',
    );
    stage = '切换会话后保留首条草稿';
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await searchBox.fill('K123465');
    await searchDialog.getByRole('option', { name: /K123465.*写法检查/ }).click();
    assert.equal(
      await page.getByRole('textbox', { name: '消息', exact: true }).inputValue(),
      editedDraft,
    );
    stage = '插话在下一步生效';
    await createConversation(page, harness.projectId, 'read_only');
    const steering = harness.plan('steering');
    await send(page, '检查资料，稍后我会补充范围。');
    await bounded(steering.reached);
    const note = '只列出写法差异，正确编号保留待确认。';
    assert.equal((await send(page, note, '插话')).kind, 'steering');
    steering.release();
    await page.getByText(`已收到插话：${note}`, { exact: false }).waitFor();
    assert.equal(steering.observed.latestUser, note);
    assert.equal(await page.getByText(note, { exact: true }).count(), 1);
    stage = '权限模式从下一轮目录生效';
    await createConversation(page, harness.projectId, 'ask');
    const mode = harness.plan('mode');
    await send(page, '核对资料后准备说明。');
    await bounded(mode.reached);
    const planSummary = page.locator('summary').filter({ hasText: '先定位资料，再逐条核对原文。' });
    await planSummary.waitFor();
    assert.ok((await planSummary.textContent())?.includes('第 1 步，共 2 步'));
    if ((await planSummary.locator('..').getAttribute('open')) === null) await planSummary.click();
    assert.equal(await planSummary.locator('..').locator('ol > li').count(), 2);
    await page.screenshot({ path: path.join(output, 'plan-active.png'), fullPage: true });
    assert.ok(mode.observed.toolNames[0]?.includes('ws_write'));
    const modeResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' && response.url().endsWith('/permission-mode'),
    );
    await page.getByRole('combobox', { name: '权限模式', exact: true }).selectOption('read_only');
    assert.equal((await modeResponse).status(), 200);
    mode.release();
    await page.getByText('已读取资料原文，正确编号仍待确认。', { exact: false }).waitFor();
    assert.equal(mode.observed.toolNames.at(-1)?.includes('ws_write'), false);
    stage = '停止无迟到正文';
    await createConversation(page, harness.projectId, 'ask');
    const stopped = harness.plan('stop');
    const active = await send(page, '检查资料，本轮测试停止。');
    await bounded(stopped.reached);
    await page.getByRole('button', { name: '运行详情', exact: true }).click();
    const runDetails = page.getByRole('complementary', { name: '运行详情', exact: true });
    await runDetails.getByText('正在处理', { exact: true }).waitFor();
    harness.disconnectStreams();
    await page.getByRole('button', { name: '重新连接', exact: true }).first().waitFor();
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await until(
      async () =>
        (await harness.pool.query('SELECT status FROM run WHERE id=$1', [active.runId])).rows[0]
          ?.status === 'stopped',
    );
    stopped.release();
    await until(
      async () =>
        (
          await harness.pool.query(
            "SELECT id FROM usage_ledger WHERE run_id=$1 AND status='reserved'",
            [active.runId],
          )
        ).rowCount === 0,
    );
    assert.equal(await page.getByText('此迟到结果不应显示。', { exact: true }).count(), 0);
    assert.equal(
      (
        await harness.pool.query(
          "SELECT id FROM tool_invocation WHERE run_id=$1 AND tool_name='doc_read'",
          [active.runId],
        )
      ).rowCount,
      0,
    );
    await page.getByRole('region', { name: '中途停止汇报' }).waitFor();
    await runDetails.getByText('已停止', { exact: true }).waitFor();
    await runDetails.getByRole('region', { name: '工具步骤时间线', exact: true }).waitFor();
    await captureWorkbench(page, output, 'pr-u2-11-stop-details.png');
    await runDetails.getByRole('button', { name: '关闭右栏', exact: true }).click();
    stage = '浏览器过程批准';
    await createConversation(page, harness.projectId, 'ask');
    harness.plan('approval');
    const rejectionRun = await send(page, '请给王敏登记一条待我判断的本地提醒。');
    await page.getByRole('button', { name: '拒绝', exact: true }).waitFor();
    await page
      .getByText(/^工具过程/)
      .first()
      .click();
    await page.screenshot({ path: path.join(output, 'approval-pending.png'), fullPage: true });
    await captureWorkbench(page, output, 'pr-u2-04-approval.png');
    await page.getByText('填写拒绝原因（可选）', { exact: true }).click();
    await page.getByRole('textbox', { name: /^拒绝原因/ }).fill('资料还未核对，先不要登记提醒。');
    const rejection = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/api\/approvals\/[^/]+$/.test(new URL(response.url()).pathname),
    );
    await page.getByRole('button', { name: '拒绝', exact: true }).click();
    assert.equal((await rejection).request().postDataJSON().action, 'reject');
    await page.getByText('发起人已拒绝，本次没有登记内部测试消息。', { exact: false }).waitFor();
    assert.equal(
      (
        await harness.pool.query('SELECT id FROM internal_outbound_message WHERE run_id=$1', [
          rejectionRun.runId,
        ])
      ).rowCount,
      0,
    );
    await createConversation(page, harness.projectId, 'ask');
    harness.plan('approval');
    const approvalRun = await send(page, '请给王敏登记一条本地核查提醒。');
    await page.getByRole('button', { name: '允许', exact: true }).waitFor();
    assert.equal(
      (
        await harness.pool.query('SELECT id FROM internal_outbound_message WHERE run_id=$1', [
          approvalRun.runId,
        ])
      ).rowCount,
      0,
    );
    const allowed = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/api\/approvals\/[^/]+$/.test(new URL(response.url()).pathname),
    );
    await page.getByRole('button', { name: '允许', exact: true }).click();
    assert.equal((await allowed).request().postDataJSON().action, 'allow_once');
    await until(
      async () =>
        (
          await harness.pool.query('SELECT id FROM internal_outbound_message WHERE run_id=$1', [
            approvalRun.runId,
          ])
        ).rowCount === 1,
    );
    await page.getByText('内部测试消息已排队，未发送到任何外部对象。', { exact: false }).waitFor();
    await createConversation(page, harness.projectId, 'ask');
    harness.plan('approval', 'admin');
    const grantedRun = await send(page, '请给李晨登记一条本地核查提醒。');
    await page.getByRole('button', { name: '本对话中都允许', exact: true }).waitFor();
    const granted = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/api\/approvals\/[^/]+$/.test(new URL(response.url()).pathname),
    );
    await page.getByRole('button', { name: '本对话中都允许', exact: true }).click();
    assert.equal((await granted).request().postDataJSON().action, 'allow_conversation');
    await page.getByText('内部测试消息已排队，未发送到任何外部对象。', { exact: false }).waitFor();
    assert.equal(
      (
        await harness.pool.query('SELECT id FROM internal_outbound_message WHERE run_id=$1', [
          grantedRun.runId,
        ])
      ).rowCount,
      1,
    );
    const decisions = (
      await harness.pool.query<{ action: string }>(
        'SELECT action FROM tool_approval_decision ORDER BY created_at,id',
      )
    ).rows;
    assert.deepEqual(
      decisions.map((decision) => decision.action),
      ['reject', 'allow_once', 'allow_conversation'],
    );
    await reviewBrowserFlow(
      page,
      harness,
      {
        create: (title) => createConversation(page!, harness.projectId, 'ask', title),
        send: (text) => send(page!, text),
        until,
        async beforeReload() {
          const previous = await page!.evaluate(() => {
            const state = globalThis as typeof globalThis & {
              __certCspViolations: number;
              __certCspDirectives: string[];
            };
            return { count: state.__certCspViolations, directives: state.__certCspDirectives };
          });
          priorCspViolations += previous.count;
          for (const directive of previous.directives) priorCspDirectives.add(directive);
        },
        stage: (name) => {
          stage = name;
        },
      },
      output,
    );
    stage = '新版项目首页';
    await page.getByRole('button', { name: 'L08 510(k)', exact: true }).click();
    const home = page.getByRole('region', { name: '项目对话', exact: true });
    await home.getByRole('heading', { name: '工作区版本', exact: true }).waitFor();
    await home.getByText('第 3 版', { exact: true }).waitFor();
    await home.getByRole('button', { name: '打开对话：L08审核状态验收', exact: true }).waitFor();
    await page.getByRole('button', { name: '维护Agent', exact: true }).click();
    await home.getByText('注册Agent', { exact: true }).waitFor();
    await page.getByRole('button', { name: '注册Agent', exact: true }).click();
    await captureWorkbench(page, output, 'pr-u4-03-project.png');
    stage = '新版文件与历史版本';
    await home.getByRole('button', { name: '全部文件', exact: true }).click();
    const files = page.getByRole('region', { name: '项目文件', exact: true });
    await files
      .getByRole('region', { name: '工作区版本历史', exact: true })
      .getByRole('button', { name: '第 2 版', exact: true })
      .click();
    const selected = files.getByRole('combobox', { name: '文件版本', exact: true });
    assert.equal(await selected.locator('option:checked').textContent(), '第 2 版');
    await files
      .getByRole('button', { name: `查看文件：${browserReviewPath}`, exact: true })
      .click();
    const file = page.getByRole('complementary', { name: '文件', exact: true });
    await file.getByRole('heading', { name: 'L08 K号写法核查', exact: true }).waitFor();
    await file
      .getByText('两处写法不同，正确编号待注册人员核对原件确认。', { exact: false })
      .waitFor();
    await captureWorkbench(page, output, 'pr-u4-08-files.png');
    await file.getByRole('button', { name: '关闭右栏', exact: true }).click();
    stage = '打开项目资料';
    await page.getByRole('button', { name: '资料', exact: true }).click();
    const documents = page.getByRole('region', { name: '项目资料', exact: true });
    const documentLink = documents.getByRole('button', {
      name: '打开资料：510(k) summary.pdf',
      exact: true,
    });
    stage = '项目资料列表中的样本文件';
    await documentLink.waitFor();
    stage = '项目资料的 ZIP 与目录输入';
    await documents.getByLabel('选择 ZIP 资料包', { exact: true }).waitFor({ state: 'attached' });
    await documents.getByLabel('选择资料目录', { exact: true }).waitFor({ state: 'attached' });
    assert.equal(
      await documents.getByRole('button', { name: '导入资料包', exact: true }).isDisabled(),
      true,
    );
    stage = '从资料列表打开样本原文';
    await captureWorkbench(page, output, 'pr-u4-09-documents.png');
    await documentLink.click();
    const evidence = page.getByRole('complementary', { name: '原文依据', exact: true });
    await evidence.getByRole('region', { name: 'D035 第 1 页原文', exact: true }).waitFor();
    await evidence.getByRole('button', { name: '关闭右栏', exact: true }).click();
    stage = '新版个人设置和权限入口';
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    await settings.getByText('zhangsan', { exact: true }).waitFor();
    await settings.getByText('已连接', { exact: true }).waitFor();
    assert.equal(await settings.getByRole('button', { name: '维护页', exact: true }).count(), 0);
    await captureWorkbench(page, output, 'pr-u4-15-settings.png');
    stage = '技能版本审核、停用与回退';
    const draft = parseSkillDraftMarkdown(
      await readFile(
        new URL('../../../../skills/R01-注册立项演示/SKILL.md', import.meta.url),
        'utf8',
      ),
    );
    const firstSkill = await stageSkillVersion(harness.pool, draft);
    const secondSkill = await stageSkillVersion(harness.pool, {
      metadata: { ...draft.metadata, version: '0.2.0-demo' },
      body: `${draft.body}\n\n补充核对资料版本。`,
    });
    const versions = settings.getByRole('region', { name: '技能版本管理', exact: true });
    await versions.getByRole('button', { name: '查看技能版本', exact: true }).click();
    const list = versions.getByRole('combobox', { name: '技能版本', exact: true });
    await list.selectOption(firstSkill.id);
    const card = versions.getByRole('article', { name: '技能审核卡', exact: true });
    await card
      .getByRole('heading', { name: '注册立项资料核对演示 0.1.0-demo', exact: true })
      .waitFor();
    await card
      .getByText('适用模式为只读、请求批准、完全允许。送审风险为标准。', { exact: true })
      .waitFor();
    await card.scrollIntoViewIfNeeded();
    await captureWorkbench(page, output, 'pr24-skill-review.png');
    await card.getByRole('button', { name: '批准并发布', exact: true }).click();
    await card.getByRole('button', { name: '停用当前版本', exact: true }).waitFor();
    await list.selectOption(secondSkill.id);
    await card.getByRole('button', { name: '批准并发布', exact: true }).click();
    await card.getByRole('button', { name: '停用当前版本', exact: true }).click();
    await list.selectOption(firstSkill.id);
    const rollbackSkill = card.getByRole('button', { name: '退回上一版', exact: true });
    await rollbackSkill.waitFor();
    await card.scrollIntoViewIfNeeded();
    await captureWorkbench(page, output, 'pr24-skill-rollback.png');
    await rollbackSkill.click();
    await card.getByRole('button', { name: '停用当前版本', exact: true }).waitFor();
    await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
    stage = '外部核实：发起、人工插话和原样存档';
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const lexicon = settings.getByRole('region', { name: '保密词表', exact: true });
    await lexicon.getByRole('textbox', { name: '新保密词', exact: true }).fill('示例客户甲');
    await lexicon.getByRole('button', { name: '添加', exact: true }).click();
    await lexicon.getByText('示例客户甲', { exact: true }).waitFor();
    await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
    await page.getByRole('button', { name: '外部模型', exact: true }).click();
    const group = page.getByRole('region', { name: '外部核实群聊', exact: true });
    const title = '请核对示例客户甲的合成清单。';
    const nativeSend = harness.verification.runtime.send;
    const earlierVerificationCalls = harness.verification.requests.length;
    let releaseInitial!: () => void;
    const waiting = new Promise<void>((resolve) => {
      releaseInitial = resolve;
    });
    let calls = 0;
    harness.verification.runtime.send = (model, prompt, dispatch) =>
      nativeSend(model, prompt, async () => {
        await dispatch();
        if (++calls === 1) await waiting;
      });
    try {
      const stream = page.waitForResponse((response) =>
        /^\/api\/verification\/rooms\/[^/]+\/events$/.test(new URL(response.url()).pathname),
      );
      await group.getByRole('textbox', { name: '核实问题', exact: true }).fill(title);
      await group
        .getByRole('combobox', { name: '关联项目', exact: true })
        .selectOption(harness.projectId);
      await group.getByRole('button', { name: '发起核实', exact: true }).click();
      assert.match((await stream).headers()['content-type'] ?? '', /text\/event-stream/u);
      await group.getByText('GPT 正在回答…', { exact: true }).waitFor();
      await group.getByRole('button', { name: '@Claude', exact: true }).click();
      await group
        .getByRole('textbox', { name: '在群里说话', exact: true })
        .fill('补充：示例客户甲要同时核对附件。');
      await group.getByRole('button', { name: '发送群聊发言', exact: true }).click();
      await group.getByText('补充：示例客户甲要同时核对附件。', { exact: true }).waitFor();
      await captureWorkbench(page, output, 'pr-d6-14a-verification.png');
    } finally {
      releaseInitial();
    }
    await group.getByRole('link', { name: '合成核实资料 ↗', exact: true }).nth(1).waitFor();
    const second = harness.verification.requests[earlierVerificationCalls + 1];
    assert.ok(second);
    assert.equal(second.model, 'claude-flagship');
    assert.equal(
      second.prompt.transcript.some(({ role }) => role === 'gpt-flagship 第1轮'),
      true,
    );
    assert.match(JSON.stringify(second.prompt), /补充：/u);
    assert.equal(JSON.stringify(second.prompt).includes('示例客户甲'), false);
    await group
      .getByText(/发送前已自动替换.*查看实际发出的内容/u)
      .last()
      .click();
    const sent = group.locator('.verification-sent pre').last();
    await sent.waitFor();
    const snapshot = JSON.parse((await sent.textContent())!);
    assert.deepEqual(snapshot, { model: 'claude-flagship', channel: 'cursor', ...second.prompt });

    stage = '停止并整理，跳回原发言和发送引用';
    await group.getByRole('button', { name: '停止并整理', exact: true }).click();
    const conclusions = group.getByRole('complementary', { name: '核实结论', exact: true });
    await conclusions.getByText(/^可信 1$/u).waitFor();
    await conclusions.getByText(/^有分歧 1$/u).waitFor();
    await conclusions.getByText(/^待核实 1$/u).waitFor();
    await conclusions.getByText(/^人工提供 1$/u).waitFor();
    await captureWorkbench(page, output, 'pr-d6-14b-verification.png');
    await conclusions.getByRole('button', { name: 'GPT的发言', exact: true }).first().click();
    const focusedPost = page.locator('article.verification-post:focus');
    await focusedPost.waitFor();
    assert.match((await focusedPost.textContent()) ?? '', /GPT/u);
    await conclusions.getByRole('button', { name: '发给 Agent', exact: true }).click();
    const share = group.getByRole('form', { name: '把核实结论发给 Agent' });
    await share
      .getByRole('combobox', { name: '关联项目', exact: true })
      .selectOption(harness.projectId);
    await share
      .getByRole('combobox', { name: '目标对话', exact: true })
      .selectOption(draftConversation);
    harness.plan('external_quote');
    await share.getByRole('button', { name: '发送引用', exact: true }).click();
    await share.getByText('结论已发给目标对话。', { exact: true }).waitFor();
    const quote = (
      await harness.pool.query<{ text: string }>(
        "SELECT message_json->>'content' AS text FROM conversation_message WHERE conversation_id=$1 AND message_json->>'role'='user' ORDER BY seq DESC LIMIT 1",
        [draftConversation],
      )
    ).rows[0]!.text;
    assert.match(quote, /外部核实的引用资料/u);
    assert.match(quote, /GPT：建议准备附件。/u);
    assert.match(quote, /Claude：应先核对附件要求。/u);
    assert.match(quote, /主持人取舍：先回查示例清单中的附件要求。/u);
    assert.equal(quote.includes('示例客户甲'), false);
    await until(
      async () =>
        (
          await harness.pool.query(
            "SELECT id FROM run WHERE conversation_id=$1 AND status NOT IN ('queued','running','waiting')",
            [draftConversation],
          )
        ).rowCount === 1,
    );
    stage = '外发清单下载和打开对应群聊';
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await settings
      .getByRole('region', { name: '外部模型设置', exact: true })
      .getByText('模拟 Cursor 通道。', { exact: true })
      .waitFor();
    const externalArchive = settings.getByRole('region', { name: '外发记录', exact: true });
    await externalArchive
      .getByText(/核实：请核对示例客户甲的合成清单。.*Cursor/u)
      .first()
      .waitFor();
    await captureWorkbench(page, output, 'pr-d6-15-privacy.png');
    const downloadEvent = page.waitForEvent('download');
    await externalArchive.getByRole('button', { name: '下载外发清单', exact: true }).click();
    const downloaded = await downloadEvent;
    assert.match(downloaded.suggestedFilename(), /^外发清单-\d{4}-\d{2}-\d{2}\.json$/u);
    const archiveChunks: Buffer[] = [];
    for await (const chunk of await downloaded.createReadStream())
      archiveChunks.push(Buffer.from(chunk as Uint8Array));
    const exported = JSON.parse(Buffer.concat(archiveChunks).toString('utf8'));
    const ownRoom = (
      await harness.pool.query<{ id: string }>(
        'SELECT id FROM external_model_conversation WHERE title=$1',
        [title],
      )
    ).rows[0]!.id;
    assert.equal(
      exported.filter((entry: { conversationId: string }) => entry.conversationId === ownRoom)
        .length,
      2,
    );
    assert.equal(JSON.stringify(exported).includes('示例客户甲'), false);
    await externalArchive
      .getByText(/核实：请核对示例客户甲的合成清单。.*Cursor/u)
      .first()
      .click();
    await externalArchive
      .getByRole('button', { name: '打开核实群聊', exact: true })
      .first()
      .click();
    await conclusions.getByText(/^可信 1$/u).waitFor();
    stage = '核实结束后在原群继续发言';
    await group.getByRole('button', { name: '@GPT', exact: true }).click();
    await group
      .getByRole('textbox', { name: '在群里说话', exact: true })
      .fill('请在原核实群继续检查。');
    await group.getByRole('button', { name: '发送群聊发言', exact: true }).click();
    await group.getByRole('link', { name: '合成核实资料 ↗', exact: true }).nth(2).waitFor();
    await group.getByRole('button', { name: '停止并整理', exact: true }).click();
    await conclusions.getByText(/^人工提供 2$/u).waitFor();
    await page.keyboard.press('Control+k');
    const verificationSearch = page.getByRole('combobox', { name: '搜索项目或对话', exact: true });
    await verificationSearch.fill('示例客户甲');
    await page
      .getByRole('group', { name: '核实记录', exact: true })
      .getByRole('option')
      .first()
      .click();
    await conclusions.getByText(/^人工提供 2$/u).waitFor();
    stage = '维护对话和外发提案';
    await page.getByRole('button', { name: '维护Agent', exact: true }).click();
    await page.getByRole('button', { name: 'L08 年度注册（验收示例）', exact: true }).click();
    for (const action of ['rejected', 'approved'] as const) {
      await createConversation(
        page,
        harness.maintenanceProjectId,
        undefined,
        action === 'rejected' ? '年度注册核查' : '年度注册提案复验',
      );
      harness.plan('proposal');
      const proposalRun = await send(page, '请准备供审核的续期材料核对提案。');
      if (action === 'rejected') {
        await page.getByRole('button', { name: '查看提案', exact: true }).click();
      } else {
        await page.getByRole('button', { name: /待我处理/ }).click();
        const inbox = page.getByRole('region', { name: '待我处理事项', exact: true });
        const item = inbox.getByRole('button', { name: /外发提案.*查看提案/ });
        await item.waitFor();
        await captureWorkbench(page, output, 'pr-u4-12-inbox.png');
        const filters = page.getByRole('group', { name: '按类型筛选待处理事项', exact: true });
        await filters.getByRole('button', { name: /^批准请求 / }).click();
        await inbox.getByText('当前没有这个类型的待处理事项。', { exact: true }).waitFor();
        await filters.getByRole('button', { name: /^外发提案 / }).click();
        await item.click();
      }
      const proposal = page.getByRole('article', { name: '提案内容', exact: true });
      await proposal.getByText('核对年度注册联络人协议（本地测试）', { exact: true }).waitFor();
      await proposal.getByText('联络人 A <renewal@example.invalid>', { exact: true }).waitFor();
      const proposalId = (
        await harness.pool.query<{ id: string }>(
          "SELECT id FROM proposal WHERE run_id=$1 AND status='proposed' AND channel='local_test'",
          [proposalRun.runId],
        )
      ).rows[0]!.id;
      assert.equal(
        (
          await harness.pool.query('SELECT id FROM outbound_message WHERE proposal_id=$1', [
            proposalId,
          ])
        ).rowCount,
        0,
      );
      if (action === 'rejected') await captureWorkbench(page, output, 'pr-u3-10-proposal.png');
      const decision: Promise<Response> = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === 'POST' &&
          new URL(candidate.url()).pathname === `/api/proposals/${proposalId}/decision`,
      );
      await proposal
        .getByRole('button', { name: action === 'approved' ? '批准本地测试' : '拒绝', exact: true })
        .click();
      const response = await decision;
      assert.equal(response.status(), 200);
      assert.equal(response.request().postDataJSON().action, action);
      await proposal
        .getByText(action === 'approved' ? '已批准，等待本地测试' : '已拒绝', { exact: true })
        .waitFor();
      const queue = (
        await harness.pool.query<{ channel: string; status: string }>(
          'SELECT channel,status FROM outbound_message WHERE proposal_id=$1',
          [proposalId],
        )
      ).rows;
      assert.deepEqual(
        queue,
        action === 'approved' ? [{ channel: 'local_test', status: 'queued' }] : [],
      );
      await page.getByRole('button', { name: '关闭右栏', exact: true }).click();
      if (action === 'approved') {
        await page
          .getByRole('region', { name: '待我处理事项' })
          .getByRole('button', { name: /外发提案.*查看提案/ })
          .waitFor({ state: 'hidden' });
        stage = '模拟邮件结果未知与发起人对账';
        const { queueId } = (await response.json()) as { queueId: string };
        const simulated = await processTestOutbound(harness.pool, queueId, {
          simulate: 'uncertain',
          sentFolder: 'no_store',
        });
        assert.equal(simulated.status, 'reconcile');
        const filters = page.getByRole('group', { name: '按类型筛选待处理事项' });
        await filters.getByRole('button', { name: '外发结果 1', exact: true }).click();
        const unknown = page
          .getByRole('region', { name: '待我处理事项' })
          .getByRole('button', { name: /外发结果.*查看和对账/u });
        await unknown.click();
        const reconcile = proposal.getByRole('region', { name: '核对发送结果', exact: true });
        await reconcile.getByText(simulated.dispatchId, { exact: true }).waitFor();
        await captureWorkbench(page, output, 'pr-d7-outbound-reconcile.png');
        const reconciled = page.waitForResponse(
          (candidate) =>
            candidate.request().method() === 'POST' &&
            new URL(candidate.url()).pathname === `/api/proposals/${proposalId}/reconciliation`,
        );
        await reconcile.getByRole('button', { name: '确认模拟已发出', exact: true }).click();
        assert.equal((await reconciled).status(), 200);
        await proposal.getByRole('status').filter({ hasText: '本地测试完成' }).waitFor();
        await page.getByRole('button', { name: '关闭右栏', exact: true }).click();
        await unknown.waitFor({ state: 'hidden' });
        stage = '站内期限提醒出现并确认';
        const now = new Date();
        const deadline = calculateDeadline({
          startDate: now.toISOString().slice(0, 10),
          quantity: 0,
          unit: 'calendar_days',
          jurisdictionTz: 'UTC',
        });
        await harness.pool.query(
          `INSERT INTO timer(id,goal_id,project_id,conversation_id,title,profile,calculation,due_on,due_at,jurisdiction_tz)
           VALUES($1,$1,$2,$3,'验收示例证照到期','certificate',$4,$5,$6,'UTC')`,
          [
            developmentGoalId,
            harness.projectId,
            draftConversation,
            JSON.stringify(deadline.calculation),
            deadline.dueDate,
            deadline.dueAt,
          ],
        );
        await scanDeadlineReminders(harness.pool, now);
        const notices = page.getByRole('group', { name: '按类型筛选待处理事项', exact: true });
        await notices.getByRole('button', { name: '期限提醒 1', exact: true }).waitFor();
        await notices.getByRole('button', { name: '期限提醒 1', exact: true }).click();
        const reminder = page.locator('.live-deadline-row').filter({ hasText: '验收示例证照到期' });
        await reminder.getByText('当地今日到期', { exact: true }).waitFor();
        await reminder.getByText(`${deadline.beijingTime}（北京）`, { exact: true }).waitFor();
        await page
          .getByRole('complementary', { name: '到期和完成记录', exact: true })
          .getByText('验收示例证照到期', { exact: true })
          .waitFor();
        await captureWorkbench(page, output, 'pr-15-12-deadline-inbox.png');
        await reminder.getByRole('button', { name: '知道了', exact: true }).click();
        await reminder.waitFor({ state: 'hidden' });
        await page.getByRole('button', { name: 'L08 年度注册（验收示例）', exact: true }).click();
        await page.getByRole('button', { name: '打开对话：年度注册提案复验', exact: true }).click();
      }
      stage = '重新打开提案保留最终状态';
      await page
        .getByText(action === 'approved' ? '外发提案 · 本地测试完成' : '外发提案 · 已拒绝', {
          exact: true,
        })
        .waitFor();
      await page.getByRole('button', { name: '查看提案', exact: true }).click();
      await proposal
        .getByText(action === 'approved' ? '本地测试完成' : '已拒绝', { exact: true })
        .waitFor();
      assert.equal(await proposal.getByRole('button', { name: '批准本地测试' }).count(), 0);
      await page.getByRole('button', { name: '关闭右栏', exact: true }).click();
    }
    stage = '模拟外发重新提出只准备可编辑草稿';
    const reproposeConversation = await createConversation(
      page,
      harness.maintenanceProjectId,
      undefined,
      '重新提出验收',
    );
    const reproposeModel = harness.plan('proposal');
    const reproposedRun = await send(page, '请准备合成提案，由人核对模拟结果。');
    await page.getByRole('button', { name: '查看提案', exact: true }).click();
    const reproposePanel = page.getByRole('article', { name: '提案内容', exact: true });
    const reapprove = page.waitForResponse(
      (res) =>
        res.request().method() === 'POST' &&
        /\/api\/proposals\/[^/]+\/decision$/u.test(new URL(res.url()).pathname),
    );
    await reproposePanel.getByRole('button', { name: '批准本地测试', exact: true }).click();
    const retryQueue = (await (await reapprove).json()) as { queueId: string; proposalId: string };
    await reproposePanel.getByText('已批准，等待本地测试', { exact: true }).waitFor();
    assert.equal(
      (await processTestOutbound(harness.pool, retryQueue.queueId, { simulate: 'failure' })).status,
      'failed',
    );
    await page.getByRole('button', { name: '关闭右栏', exact: true }).click();
    await page.getByRole('button', { name: /待我处理/u }).click();
    await page
      .getByRole('group', { name: '按类型筛选待处理事项' })
      .getByRole('button', { name: '外发结果 1', exact: true })
      .click();
    await page
      .getByRole('region', { name: '待我处理事项' })
      .getByRole('button', { name: /外发结果.*查看和对账/u })
      .click();
    await reproposePanel.getByRole('button', { name: '重新提出', exact: true }).click();
    await page.getByRole('heading', { name: '重新提出验收', exact: true }).waitFor();
    const outboundDraft = await page
      .getByRole('textbox', { name: '消息', exact: true })
      .inputValue();
    assert.ok(outboundDraft.includes(retryQueue.proposalId));
    await page.getByRole('button', { name: '查看提案', exact: true }).click();
    await reproposePanel.getByRole('button', { name: '打开原对话准备草稿', exact: true }).click();
    assert.equal(
      await page.getByRole('textbox', { name: '消息', exact: true }).inputValue(),
      outboundDraft,
    );
    assert.equal(reproposeModel.observed.calls, 1);
    assert.deepEqual(
      (
        await harness.pool.query('SELECT id FROM run WHERE conversation_id=$1', [
          reproposeConversation,
        ])
      ).rows,
      [{ id: reproposedRun.runId }],
    );
    stage = '共享对话只读';
    await page.getByRole('button', { name: '注册Agent', exact: true }).click();
    await page.getByRole('button', { name: 'L08 510(k)', exact: true }).click();
    await page.getByRole('button', { name: '部门对话', exact: true }).click();
    await page.getByRole('button', { name: '打开对话：王敏的资料核对', exact: true }).click();
    await page.getByText('此对话由同部门成员发起，你可以查看。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: '消息', exact: true }).count(), 0);
    assert.equal(await page.getByRole('combobox', { name: '权限模式', exact: true }).count(), 0);
    for (const name of ['停止', '允许', '本对话中都允许', '拒绝'])
      assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0);
    await page.setViewportSize({ width: 1280, height: 800 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, 'conversation-shared.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    stage = '仅管理权限可打开维护页';
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await settings.getByRole('button', { name: '退出登录', exact: true }).click();
    authenticated = false;
    try {
      await page
        .getByRole('textbox', { name: '账号', exact: true })
        .fill(harness.managementCredentials.username);
      await page.getByLabel('密码', { exact: true }).fill(harness.managementCredentials.password);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page.getByRole('button', { name: '设置', exact: true }).waitFor();
    } catch {
      throw new Error('BROWSER_MANAGEMENT_LOGIN_FAILED');
    }
    authenticated = true;
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const maintenanceEntry = settings.getByRole('button', { name: '维护页', exact: true });
    await maintenanceEntry.press('Enter');
    const management = page.getByRole('dialog', { name: '维护', exact: true });
    await management.getByRole('heading', { name: '预算与用量', exact: true }).waitFor();
    await management.getByText('管理权限已启用', { exact: false }).waitFor();
    await management
      .getByLabel('外部核实用量')
      .filter({ hasText: /本月 5 次/u })
      .waitFor();
    assert.ok((await management.getByText('尚未接入', { exact: true }).count()) > 0);
    await captureWorkbench(page, output, 'pr-u4-16-management.png');
    await captureWorkbench(page, output, 'pr-d6-16-budget.png');
    const backToSettings = management.getByRole('button', { name: '返回设置', exact: true });
    assert.equal(await backToSettings.evaluate((el) => el === document.activeElement), true);
    await backToSettings.press('Enter');
    await settings.getByRole('heading', { name: '个人与通知', exact: true }).waitFor();
    assert.equal(await maintenanceEntry.evaluate((el) => el === document.activeElement), true);
    stage = 'Agent 在对话中自行发起核实并使用人工补充';
    const waitLimit = settings.getByRole('spinbutton', { name: '核实等待上限', exact: true });
    await waitLimit.waitFor();
    assert.equal(await waitLimit.inputValue(), '60');
    await waitLimit.fill('75');
    await settings.getByRole('button', { name: '保存外部模型设置', exact: true }).click();
    await until(
      async () =>
        (await harness.pool.query('SELECT wait_minutes FROM verification_preference')).rows[0]
          ?.wait_minutes === 75,
    );
    await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
    await createConversation(page, harness.projectId, 'read_only', 'Agent 自动外部核实验收');
    const model = harness.plan('consult_verification');
    const verificationSend = harness.verification.runtime.send;
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let seen = 0;
    let verificationRunId: string;
    harness.verification.runtime.send = (profile, prompt, dispatch) =>
      verificationSend(profile, prompt, async () => {
        await dispatch();
        if (++seen === 1) await gate;
      });
    try {
      verificationRunId = (await send(page, '请做合成版本核查，遇到不确定可自行核实。')).runId;
      const linked = page.getByRole('list', { name: '对话中的外部核实', exact: true });
      await linked.getByText('正在请外部模型核实…', { exact: true }).waitFor();
      await linked.getByText(/你的消息会和结论一起交给它/u).waitFor();
      assert.ok(await linked.locator('time').getAttribute('dateTime'));
      const buffered = await send(page, '对话补充：优先比较两份版本。', '插话');
      assert.equal(buffered.kind, 'steering');
      await linked.getByRole('button', { name: '查看群聊', exact: true }).click();
      const linkedGroup = page.getByRole('region', { name: '外部核实群聊', exact: true });
      await linkedGroup
        .getByRole('textbox', { name: '在群里说话', exact: true })
        .fill('人工补充：检查页码与版本。');
      await linkedGroup.getByRole('button', { name: '发送群聊发言', exact: true }).click();
      await linkedGroup
        .locator('article.verification-person')
        .getByText('人工补充：检查页码与版本。', { exact: true })
        .waitFor();
      unblock();
      await linkedGroup
        .getByRole('link', { name: '合成核实资料 ↗', exact: true })
        .first()
        .waitFor();
      await linkedGroup.getByRole('button', { name: '停止并整理', exact: true }).click();
      await linkedGroup.getByRole('complementary', { name: '核实结论', exact: true }).waitFor();
      await linkedGroup.getByRole('button', { name: '打开原对话', exact: true }).click();
      await page
        .getByText('收到核实结论及人工补充，继续核查页码与版本。', { exact: true })
        .waitFor();
      assert.equal(model.observed.calls, 2);
      assert.equal(model.observed.latestUser, '对话补充：优先比较两份版本。');
      await linked.getByText('外部核实已完成', { exact: true }).waitFor();
      await captureWorkbench(page, output, 'pr-d4-04-agent-verification.png');
    } finally {
      unblock();
      harness.verification.runtime.send = verificationSend;
    }
    stage = '核实提醒在成功刷新详情后才确认';
    const reminder = (
      await harness.pool.query<{ id: string; room_id: string }>(
        `INSERT INTO verification_notice(room_id,recipient_user_id,kind,position)
       SELECT l.room_id,l.requester,'late',10000 FROM verification_link l WHERE l.run_id=$1
       RETURNING id,room_id`,
        [verificationRunId],
      )
    ).rows[0]!;
    const openInbox = page.getByRole('button', { name: /待我处理/u });
    const reminderItem = page
      .getByRole('region', { name: '待我处理事项' })
      .getByRole('button', { name: /迟到的核实结论/u });
    const details = (url: URL) => url.pathname === `/api/verification/rooms/${reminder.room_id}`;
    await page.route(details, (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
    );
    await openInbox.click();
    await reminderItem.waitFor();
    const acknowledgePath = `/api/me/verification-notices/${reminder.id}/acknowledge`;
    const failedDetail = page.waitForResponse(
      (response) => details(new URL(response.url())) && response.status() === 503,
    );
    let earlyAcknowledgements = 0;
    const observeFailedAcknowledgement = (request: Request) => {
      if (new URL(request.url()).pathname === acknowledgePath && request.method() === 'POST')
        earlyAcknowledgements++;
    };
    page.on('request', observeFailedAcknowledgement);
    await reminderItem.click();
    await failedDetail;
    await page
      .getByRole('region', { name: '外部核实群聊', exact: true })
      .getByRole('alert')
      .waitFor();
    const acknowledged = async () =>
      (
        await harness.pool.query('SELECT acknowledged_at FROM verification_notice WHERE id=$1', [
          reminder.id,
        ])
      ).rows[0]?.acknowledged_at;
    await openInbox.click();
    await reminderItem.waitFor();
    page.off('request', observeFailedAcknowledgement);
    assert.equal(earlyAcknowledgements, 0);
    assert.equal(await acknowledged(), null);
    await page.unroute(details);
    const noticeEvents: string[] = [];
    const loadedDetail = page.waitForResponse((response) => {
      const matches = details(new URL(response.url())) && response.status() === 200;
      if (matches) noticeEvents.push('详情成功');
      return matches;
    });
    const startedAcknowledgement = page.waitForRequest((request) => {
      const matches =
        new URL(request.url()).pathname === acknowledgePath && request.method() === 'POST';
      if (matches) noticeEvents.push('发出确认');
      return matches;
    });
    const acknowledgedRequest = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === acknowledgePath &&
        response.request().method() === 'POST',
    );
    await reminderItem.click();
    await Promise.all([loadedDetail, startedAcknowledgement]);
    assert.deepEqual(noticeEvents, ['详情成功', '发出确认']);
    assert.equal((await acknowledgedRequest).status(), 204);
    await until(async () => (await acknowledged()) instanceof Date);
    await page
      .getByRole('region', { name: '外部核实群聊', exact: true })
      .getByRole('button', { name: '打开原对话', exact: true })
      .click();
    await page.getByText('收到核实结论及人工补充，继续核查页码与版本。', { exact: true }).waitFor();
    stage = '停止对话时连带停止外部核实';
    await createConversation(page, harness.projectId, 'read_only', '停止外部核实验收');
    const stoppedVerificationModel = harness.plan('consult_verification');
    const originalVerificationSend = harness.verification.runtime.send;
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    harness.verification.runtime.send = (model, prompt, dispatch) =>
      originalVerificationSend(model, prompt, async () => {
        await stopGate;
        await dispatch();
      });
    try {
      const requested = await send(page, '请启动合成核实，等待外部回复。');
      const activeVerification = page.getByRole('list', { name: '对话中的外部核实', exact: true });
      await activeVerification.getByText('正在请外部模型核实…', { exact: true }).waitFor();
      await until(
        async () =>
          (
            await harness.pool.query(
              `SELECT c.id FROM verification_link l JOIN external_model_conversation c ON c.id=l.room_id
          JOIN verification_wait w ON w.room_id=c.id
          WHERE l.run_id=$1 AND c.active_model IS NOT NULL AND w.state='waiting'`,
              [requested.runId],
            )
          ).rowCount === 1,
      );
      await page.getByRole('button', { name: '停止', exact: true }).click();
      await until(
        async () =>
          (
            await harness.pool.query(
              `SELECT c.id FROM verification_link l JOIN external_model_conversation c ON c.id=l.room_id
          JOIN verification_wait w ON w.room_id=c.id
          WHERE l.run_id=$1 AND c.stopped_by IS NOT NULL AND w.state='cancelled'`,
              [requested.runId],
            )
          ).rowCount === 1,
      );
      releaseStop();
      await until(
        async () =>
          (
            await harness.pool.query(
              "SELECT room_id FROM verification_link l JOIN external_model_conversation c ON c.id=l.room_id WHERE l.run_id=$1 AND c.state='completed'",
              [requested.runId],
            )
          ).rowCount === 1,
      );
      await activeVerification.getByText('外部核实暂不可用', { exact: true }).waitFor();
      assert.equal(stoppedVerificationModel.observed.calls, 1);
    } finally {
      releaseStop();
      harness.verification.runtime.send = originalVerificationSend;
    }
    stage = 'Cursor 未登录时 Agent 把核实缺口纳入审核';
    const savedStatus = harness.verification.runtime.status;
    const externalCallCount = harness.verification.requests.length;
    harness.verification.runtime.status = 'not_signed_in';
    try {
      await until(
        async () =>
          (
            await harness.pool.query(
              "SELECT id FROM verification_worker_state WHERE status='not_signed_in'",
            )
          ).rowCount === 1,
      );
      await createConversation(page, harness.projectId, 'full', 'Cursor 失联核实验收');
      const unavailableModel = harness.plan('consult_verification_unavailable');
      await send(page, '请核对对比器械编号并提交审核。');
      await page.getByText('外部核实暂不可用', { exact: true }).waitFor();
      await page.getByRole('button', { name: '查看审核', exact: true }).last().click();
      const uncertainty = page
        .getByRole('heading', { name: '不确定事项', exact: true })
        .locator('..');
      await uncertainty.getByText(browserVerificationUncertainty, { exact: true }).waitFor();
      assert.equal(unavailableModel.observed.calls, 11);
      assert.equal(harness.verification.requests.length, externalCallCount);
    } finally {
      harness.verification.runtime.status = savedStatus;
    }
    stage = 'CSP与零外网检查';
    const cspState = await page.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        __certCspViolations: number;
        __certCspDirectives: string[];
      };
      return {
        violations: state.__certCspViolations,
        directives: [...new Set(state.__certCspDirectives)],
      };
    });
    cspState.violations += priorCspViolations;
    cspState.directives = [...new Set([...priorCspDirectives, ...cspState.directives])];
    const unknown = await harness.pool.query(
      "SELECT id FROM usage_ledger WHERE status IN ('reserved','unknown')",
    );
    const costNano = (
      await harness.pool.query<{ value: string }>(
        'SELECT COALESCE(sum(actual_nano),0)::text AS value FROM usage_ledger',
      )
    ).rows[0]!.value;
    console.log(
      '浏览器终态校验：' +
        JSON.stringify({
          externalRequests,
          fixtureImages,
          pageErrors,
          csp: cspState,
          workerHealthy: harness.healthy(),
          pendingUsage: unknown.rowCount,
          costNano,
          ...harness.diagnostics(),
        }),
    );
    assert.equal(externalRequests, 0);
    assert.ok(fixtureImages > 0);
    assert.equal(pageErrors, 0);
    assert.equal(cspState.violations, 0);
    assert.equal(harness.healthy(), true);
    assert.equal(unknown.rowCount, 0);
    assert.equal(costNano, '0');
    await writeFile(
      path.join(output, 'result.json'),
      JSON.stringify(
        {
          completedAt: new Date().toISOString(),
          environment: 'isolated_test_database',
          checks: [
            'browser_login_cookie_csrf',
            'redesigned_login_and_logo',
            'redesigned_agent_navigation_and_new_conversation',
            'mobile_sidebar_keeps_new_conversation',
            'redesigned_keyboard_search_at_1280_and_1440',
            'l08_real_tools',
            'plan_two_steps',
            'steering_next_turn',
            'mode_next_catalog',
            'default_full_permission_mode',
            'new_conversation_first_message_draft',
            'workspace_document_reference',
            'stop_without_sse',
            'stopped_run_report_and_details',
            'reject',
            'allow_once',
            'allow_conversation',
            'shared_read_only',
            'markdown_html_images_tables_code_and_stylesheet_filter',
            'markdown_script_blocked_and_image_without_referrer',
            'conversation_switch_preserves_edited_draft',
            'strict_csp',
            'l08_exact_request_ask',
            'review_eight_sections',
            'review_decisions',
            'real_evidence_highlight',
            'evidence_pair',
            'evidence_wide_and_single_navigation',
            'evidence_quote_visible_in_viewport',
            'saved_report',
            'report_download_hash',
            'chat_not_approval',
            'browser_review_freeze',
            'revision_single_path_diff',
            'review_diff_file_list_selects_target',
            'proposal_rejected_without_queue',
            'proposal_browser_approval_local_queue_only',
            'proposal_history_and_pending_inbox_update',
            'review_current_run_completed_sse',
            'review_completed_after_reopen',
            'project_home_actual_notices_and_versions',
            'file_history_select_and_open',
            'documents_open_parsed_source',
            'inbox_type_filter',
            'profile_reads_actual_account_and_stream',
            'management_entry_only_with_permission',
            'verification_start_and_manual_mention',
            'verification_order_and_redaction_archive',
            'verification_four_categories_and_source_anchor',
            'verification_conclusion_shared_to_agent',
            'verification_archive_download_and_reopen',
            'verification_resumed_after_stop',
            'verification_cursor_count_and_settings',
            'verification_realtime_stream_and_global_search',
            'review_verification_returns_evidence_to_origin',
            'browser_review_decision_resumes_original_conversation',
            'agent_verification_waits_and_resumes_with_human_input',
            'stopping_conversation_stops_linked_verification',
            'cursor_unavailable_reaches_review_uncertainty',
            'width_1280',
          ],
          externalRequests,
          fixtureImages,
          pageErrors,
          cspViolations: cspState.violations,
          pendingUsage: unknown.rowCount,
          costNano,
          screenshots: [
            'pr-u1-01-login.png',
            'pr-u1-02-new-conversation.png',
            'pr-u1-13-search.png',
            'pr-u2-04-approval.png',
            'pr-u2-11-stop-details.png',
            'pr-u2-markdown.png',
            'conversation-read.png',
            'plan-active.png',
            'approval-pending.png',
            'conversation-shared.png',
            'review-card.png',
            'review-evidence.png',
            'review-evidence-pair.png',
            'review-file.png',
            'review-approved.png',
            'review-revision-diff.png',
            'review-run-completed.png',
            'review-run-reopened.png',
            'pr-u3-10-proposal.png',
            'pr-u4-03-project.png',
            'pr-u4-08-files.png',
            'pr-u4-09-documents.png',
            'pr-u4-12-inbox.png',
            'pr-15-12-deadline-inbox.png',
            'pr-u4-15-settings.png',
            'pr-u4-16-management.png',
            'pr-d6-14a-verification.png',
            'pr-d6-14b-verification.png',
            'pr-d6-15-privacy.png',
            'pr-d6-16-budget.png',
            'pr-d4-04-agent-verification.png',
            'pr-d5-05-review-verification.png',
            'pr-d5-06-source-evidence.png',
          ],
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    console.log(
      '浏览器验收通过：真实登录、L08原文与审核冻结、修改差异、插话、权限切换、停止、过程批准、共享只读、Markdown和CSP；未调用真实模型。',
    );
  } catch (error) {
    if (authenticated && page)
      await page
        .screenshot({ path: path.join(output, 'failure.png'), fullPage: true })
        .catch(() => undefined);
    throw error;
  } finally {
    let cleanupFailed = false;
    await context?.close().catch(() => {
      cleanupFailed = true;
    });
    await browser?.close().catch(() => {
      cleanupFailed = true;
    });
    await harness.close().catch(() => {
      cleanupFailed = true;
    });
    if (cleanupFailed) {
      console.error('浏览器验收清理未完成，请核对本次测试服务；未输出连接信息。');
      process.exitCode = 1;
    }
  }
}
main().catch((error: unknown) => {
  const code =
    error instanceof Error && /^BROWSER_[A-Z_]+$/.test(error.message)
      ? error.message
      : 'BROWSER_CHECK_FAILED';
  console.error(`浏览器验收未通过：${stage}（${code}）。未输出凭据、请求正文或浏览器原始异常。`);
  process.exitCode = 1;
});
