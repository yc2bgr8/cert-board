import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { startBrowserHarness } from '../test-support/browser-harness.js';
import { reviewBrowserFlow } from '../test-support/browser-review-flow.js';

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
) {
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新对话', exact: true });
  if (title) await dialog.getByRole('textbox', { name: '对话标题', exact: true }).fill(title);
  await dialog.getByRole('combobox', { name: '选择项目', exact: true }).selectOption(projectId);
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
    await context.route('**/*', async (route) => {
      if (new URL(route.request().url()).origin !== harness.origin) {
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
        csp.includes("style-src 'self'") &&
        csp.includes("connect-src 'self'"),
    );
    assert.equal(/unsafe-inline|unsafe-eval/.test(csp), false);
    // 密码只在内存中交给浏览器，不启用trace/HAR；登录失败不传播含fill参数的异常。
    try {
      await page
        .getByRole('textbox', { name: '用户名', exact: true })
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
    stage = '新对话默认完全允许';
    await createConversation(page, harness.projectId, undefined, '默认权限验证');
    stage = 'L08资料与安全Markdown';
    await createConversation(page, harness.projectId, 'read_only');
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
    assert.equal(await page.locator('img').count(), 0);
    assert.equal(await page.locator('script:not([src])').count(), 0);
    assert.equal(
      await page.evaluate(
        () => (globalThis as typeof globalThis & { __certInjected: boolean }).__certInjected,
      ),
      false,
    );
    const externalLink = page.getByRole('link', { name: /外部参考/ });
    assert.equal(await externalLink.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(await externalLink.getAttribute('target'), '_blank');
    await page.screenshot({ path: path.join(output, 'conversation-read.png'), fullPage: true });
    await until(
      async () =>
        (await harness.pool.query('SELECT status FROM run WHERE id=$1', [first.runId])).rows[0]
          ?.status === 'completed',
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
    await planSummary.click();
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
    stage = '浏览器过程批准';
    await createConversation(page, harness.projectId, 'ask');
    harness.plan('approval');
    const rejectionRun = await send(page, '请给王敏登记一条待我判断的本地提醒。');
    await page.getByRole('button', { name: '拒绝', exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'approval-pending.png'), fullPage: true });
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
    stage = '共享对话只读';
    await page.getByRole('button', { name: 'L08 510(k)', exact: true }).click();
    await page.getByRole('button', { name: '部门对话', exact: true }).click();
    await page.getByRole('button', { name: '打开对话：王敏的资料核对', exact: true }).click();
    await page.getByText('此对话由同部门成员发起，你可以查看。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: '消息', exact: true }).count(), 0);
    assert.equal(await page.getByRole('combobox', { name: '权限模式', exact: true }).count(), 0);
    for (const name of ['停止', '允许', '本对话中都允许', '拒绝'])
      assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0);
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
          pageErrors,
          csp: cspState,
          workerHealthy: harness.healthy(),
          pendingUsage: unknown.rowCount,
          costNano,
          ...harness.diagnostics(),
        }),
    );
    assert.equal(externalRequests, 0);
    assert.equal(pageErrors, 0);
    assert.equal(cspState.violations, 0);
    assert.equal(harness.healthy(), true);
    assert.equal(unknown.rowCount, 0);
    assert.equal(costNano, '0');
    await page.setViewportSize({ width: 1280, height: 800 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, 'conversation-shared.png'), fullPage: true });
    await writeFile(
      path.join(output, 'result.json'),
      JSON.stringify(
        {
          completedAt: new Date().toISOString(),
          environment: 'isolated_test_database',
          checks: [
            'browser_login_cookie_csrf',
            'l08_real_tools',
            'plan_two_steps',
            'steering_next_turn',
            'mode_next_catalog',
            'default_full_permission_mode',
            'stop_without_sse',
            'reject',
            'allow_once',
            'allow_conversation',
            'shared_read_only',
            'markdown_sanitized',
            'strict_csp',
            'l08_exact_request_ask',
            'review_eight_sections',
            'review_decisions',
            'real_evidence_highlight',
            'evidence_pair',
            'saved_report',
            'report_download_hash',
            'chat_not_approval',
            'browser_review_freeze',
            'revision_single_path_diff',
            'review_current_run_completed_sse',
            'review_completed_after_reopen',
            'width_1280',
          ],
          externalRequests,
          pageErrors,
          cspViolations: cspState.violations,
          pendingUsage: unknown.rowCount,
          costNano,
          screenshots: [
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
