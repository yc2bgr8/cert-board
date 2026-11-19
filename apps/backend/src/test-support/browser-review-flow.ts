import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Page } from 'playwright-core';
import {
  checkReportSchema,
  documentPageReadSchema,
  reviewDiffSchema,
  structuredSubmissionSchema,
} from '@cert-board/shared';
import type { startBrowserHarness } from './browser-harness.js';
import { browserReviewPath, browserRevisionText } from './browser-review-fixture.js';

type Harness = Awaited<ReturnType<typeof startBrowserHarness>>;
type Actions = {
  create(title?: string): Promise<string>;
  send(text: string): Promise<{ runId: string; kind: string }>;
  until(check: () => boolean | Promise<boolean>): Promise<void>;
  beforeReload(): Promise<void>;
  stage(name: string): void;
};

export async function reviewBrowserFlow(
  page: Page,
  harness: Harness,
  actions: Actions,
  output: string,
) {
  actions.stage('L08原句与真实审核提交');
  const title = 'L08审核状态验收';
  const conversationId = await actions.create(title);
  const model = harness.plan('review');
  const first = await actions.send('检查L08申报资料中对比器械K号的写法');
  await actions.until(
    async () =>
      (
        await harness.pool.query(
          "SELECT id FROM review_card WHERE run_id=$1 AND status='pending'",
          [first.runId],
        )
      ).rowCount === 1,
  );
  await actions.until(
    async () =>
      (await harness.pool.query('SELECT lease_owner FROM run WHERE id=$1', [first.runId])).rows[0]
        ?.lease_owner === null,
  );
  assert.equal(model.observed.calls, 10);
  const firstCard = (
    await harness.pool.query('SELECT * FROM review_card WHERE run_id=$1', [first.runId])
  ).rows[0]!;
  const submission = structuredSubmissionSchema.parse(firstCard.structured_result);
  assert.deepEqual(
    submission.evidence.map((source) => source.page),
    [1, 5],
  );
  assert.deepEqual(
    submission.claims.map((claim) => claim.value),
    ['K170825', 'K170285'],
  );
  assert.equal(checkReportSchema.parse(firstCard.check_report).passed, true);
  const receipts = (
    await harness.pool.query(
      `SELECT i.id,p.content_json FROM tool_invocation i
    JOIN conversation_tool_result p ON p.invocation_id=i.id WHERE i.run_id=$1 AND i.tool_name='doc_read' AND i.status='completed'`,
      [first.runId],
    )
  ).rows;
  assert.equal(receipts.length, 2);
  for (const ref of firstCard.evidence_refs as Array<{ readInvocationId: string; quote: string }>) {
    const receipt = receipts.find((row) => row.id === ref.readInvocationId)!;
    assert.ok(
      documentPageReadSchema.parse(receipt.content_json.result.data).text.includes(ref.quote),
    );
  }
  await page.getByRole('button', { name: '查看审核', exact: true }).last().click();
  const card = page.getByRole('article', { name: '审核结果', exact: true });
  await card.getByRole('heading', { name: '审核卡', exact: true }).waitFor();
  assert.deepEqual(await card.getByRole('heading', { level: 3 }).allTextContents(), [
    '结论',
    '需要你做什么',
    '过程中作出的判断',
    '改动',
    '依据',
    '自检',
    '不确定事项',
    '操作',
  ]);
  await card.getByText('保留两处原文，暂不选定正确编号。', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'review-card.png'), fullPage: true });
  actions.stage('审核卡发起外部核实并回到原对话');
  const moderate = harness.verification.runtime.moderate;
  harness.verification.runtime.moderate = async (context) => {
    if (Object.values(context.attempts).reduce((sum, count) => sum + count, 0) >= 2)
      return { text: '本轮交叉核实已完成。', call: null, finish: true };
    return moderate(context);
  };
  try {
    await card.getByRole('button', { name: '让Agent核实', exact: true }).click();
    await card
      .getByRole('textbox', { name: '需要核实的疑问', exact: true })
      .fill('核实这条合成编号的出处。');
    await card.getByRole('button', { name: '发起核实', exact: true }).click();
    const external = card.getByRole('list', { name: '外部核实依据', exact: true });
    await external.getByText('外部核实', { exact: true }).waitFor();
    await external.getByRole('link', { name: '合成核实资料（外部网站）', exact: true }).waitFor();
    await external.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'pr-d4-05-review-verification.png') });
    await external.getByRole('button', { name: '查看核实群聊', exact: true }).click();
    const group = page.getByRole('region', { name: '外部核实群聊', exact: true });
    await group.getByRole('complementary', { name: '核实结论', exact: true }).waitFor();
    await group.getByRole('button', { name: '打开原对话', exact: true }).click();
    await page
      .getByRole('list', { name: '对话中的外部核实', exact: true })
      .getByText('外部核实已完成', { exact: true })
      .waitFor();
    await page.getByRole('button', { name: '查看审核', exact: true }).last().click();
    await card.getByRole('heading', { name: '审核卡', exact: true }).waitFor();
  } finally {
    harness.verification.runtime.moderate = moderate;
  }
  actions.stage('真实资料依据与逐字高亮');
  await card.getByRole('button', { name: '查看原文', exact: true }).first().click();
  const source = page.getByRole('region', { name: 'D035 第 1 页原文', exact: true });
  await source.locator('mark').waitFor();
  assert.equal(await source.locator('mark').textContent(), submission.evidence[0]!.quote);
  const parsed = source.getByLabel('D035解析原文', { exact: true });
  const excerpt = await parsed.textContent();
  await source.getByRole('button', { name: '展开解析全文', exact: true }).click();
  assert.ok((await parsed.textContent())!.length > excerpt!.length);
  assert.equal(await source.locator('mark').textContent(), submission.evidence[0]!.quote);
  await source.getByRole('button', { name: '收起解析全文', exact: true }).click();
  assert.equal(await parsed.textContent(), excerpt);
  await page.screenshot({ path: path.join(output, 'review-evidence.png'), fullPage: true });
  await page.getByRole('button', { name: '返回审核卡', exact: true }).click();
  await card.getByRole('button', { name: '并排查看两处依据', exact: true }).click();
  for (const ref of submission.evidence) {
    const region = page.getByRole('region', { name: `D035 第 ${ref.page} 页原文`, exact: true });
    await region.locator('mark').waitFor();
    assert.equal(await region.locator('mark').textContent(), ref.quote);
    assert.equal(
      await region.locator('mark').evaluate((mark) => {
        const container = mark.closest('pre')!.getBoundingClientRect();
        const highlight = mark.getBoundingClientRect();
        return highlight.top >= container.top && highlight.top < container.bottom;
      }),
      true,
    );
  }
  const pairPanel = page.getByRole('complementary', { name: '原文依据', exact: true });
  assert.ok((await pairPanel.boundingBox())!.width > 800);
  await pairPanel.getByRole('button', { name: '单份', exact: true }).click();
  assert.equal(await pairPanel.getByRole('region', { name: /D035 第 .*原文/ }).count(), 1);
  await pairPanel.getByRole('button', { name: '下一组依据', exact: true }).click();
  await pairPanel
    .getByRole('region', { name: 'D035 第 5 页原文', exact: true })
    .getByText(submission.evidence[1]!.quote, { exact: true })
    .waitFor();
  await pairPanel.getByRole('button', { name: '并排对照', exact: true }).click();
  await pairPanel.getByRole('region', { name: 'D035 第 1 页原文', exact: true }).waitFor();
  assert.equal(await pairPanel.getByRole('region', { name: /D035 第 .*原文/ }).count(), 2);
  await page.screenshot({ path: path.join(output, 'review-evidence-pair.png'), fullPage: true });
  await page.getByRole('button', { name: '返回审核卡', exact: true }).click();
  const reportRow = card.getByText(browserReviewPath, { exact: true }).locator('..');
  await reportRow.getByRole('button', { name: '打开文件', exact: true }).click();
  const file = page.getByRole('complementary', { name: '文件', exact: true });
  await file
    .getByText('两处写法不同，正确编号待注册人员核对原件确认。', { exact: false })
    .waitFor();
  const downloading = page.waitForEvent('download');
  await file.getByRole('button', { name: '下载完整文本', exact: true }).click();
  const download = await downloading;
  assert.equal(download.suggestedFilename(), path.basename(browserReviewPath));
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const value = Buffer.from(chunk as Uint8Array);
    bytes += value.length;
    assert.ok(bytes <= 1000000);
    chunks.push(value);
  }
  const originalHash = reviewDiffSchema
    .parse(firstCard.diff)
    .changes.find((change) => change.path === browserReviewPath)!.afterSha256;
  assert.equal(createHash('sha256').update(Buffer.concat(chunks)).digest('hex'), originalHash);
  await page.screenshot({ path: path.join(output, 'review-file.png'), fullPage: true });
  await page.getByRole('button', { name: '关闭右栏', exact: true }).click();
  actions.stage('聊天批准不产生决定');
  const reviewReference = harness.plan('approval_text');
  const chat = await actions.send('我已批准');
  await page
    .getByText('对话文字不能代替审批，请在审核卡上点击通过或退回修改。', { exact: false })
    .waitFor();
  await actions.until(
    async () =>
      (await harness.pool.query('SELECT lease_owner FROM run WHERE id=$1', [chat.runId])).rows[0]
        ?.lease_owner === null,
  );
  assert.equal((await harness.pool.query('SELECT id FROM review_decision')).rowCount, 0);
  assert.equal((await harness.pool.query('SELECT id FROM submission_snapshot')).rowCount, 0);
  assert.equal(reviewReference.observed.reviewVerificationReceived, true);
  assert.equal(reviewReference.observed.latestUser, '我已批准');
  actions.stage('浏览器审核通过与冻结');
  await page.getByRole('button', { name: '查看审核', exact: true }).first().click();
  const approved = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/reviews/${firstCard.id}/decision`,
  );
  await card.getByRole('button', { name: '通过', exact: true }).click();
  const approval = await approved;
  assert.equal(approval.status(), 200);
  assert.equal(approval.request().postDataJSON().action, 'approved');
  await card.getByText('已通过，工作区版本已冻结。', { exact: true }).waitFor();
  const decided = (
    await harness.pool.query(
      `SELECT d.action,d.actor_user_id,d.session_id,d.snapshot_id,s.workspace_version_id,s.kind,u.username
    FROM review_decision d JOIN submission_snapshot s ON s.id=d.snapshot_id JOIN app_user u ON u.id=d.actor_user_id WHERE d.card_id=$1`,
      [firstCard.id],
    )
  ).rows[0]!;
  assert.equal(decided.action, 'approved');
  assert.equal(decided.username, 'zhangsan');
  assert.equal(decided.kind, 'approved_review');
  assert.equal(decided.workspace_version_id, firstCard.workspace_version_id);
  assert.ok(decided.session_id);
  await page.screenshot({ path: path.join(output, 'review-approved.png'), fullPage: true });
  await page.getByRole('button', { name: '关闭右栏', exact: true }).click();
  actions.stage('修改重提只显示本次差异');
  const revision = harness.plan('revision');
  const next = await actions.send('请补充本次阅读范围后重新提交审核。');
  await actions.until(
    async () =>
      (
        await harness.pool.query(
          "SELECT id FROM review_card WHERE run_id=$1 AND status='pending'",
          [next.runId],
        )
      ).rowCount === 1,
  );
  assert.equal(revision.observed.calls, 10);
  const nextCard = (
    await harness.pool.query('SELECT * FROM review_card WHERE run_id=$1', [next.runId])
  ).rows[0]!;
  const diff = reviewDiffSchema.parse(nextCard.diff);
  assert.equal(diff.baseVersionId, firstCard.workspace_version_id);
  assert.equal(diff.changes.length, 1);
  assert.equal(diff.changes[0]!.path, browserReviewPath);
  assert.equal(diff.changes[0]!.change, 'modified');
  await actions.until(
    async () => (await page.getByRole('button', { name: '查看审核', exact: true }).count()) === 2,
  );
  await page.getByRole('button', { name: '查看审核', exact: true }).last().click();
  await card.getByRole('button', { name: '通过', exact: true }).waitFor();
  const changes = card.getByRole('heading', { name: '改动', exact: true }).locator('..');
  await changes.getByText(browserReviewPath, { exact: true }).waitFor();
  assert.equal(await changes.getByRole('listitem').count(), 1);
  await changes.getByRole('button', { name: '查看对比', exact: true }).click();
  const textDiff = page.getByRole('region', { name: '文本差异', exact: true });
  const fileNavigation = page.getByRole('navigation', { name: '改动文件列表', exact: true });
  const selectedFile = fileNavigation.getByRole('button', {
    name: `查看文本对比：${browserReviewPath}`,
    exact: true,
  });
  await selectedFile.waitFor();
  assert.equal(await selectedFile.getAttribute('aria-current'), 'true');
  await textDiff
    .locator('[data-change="added"]')
    .filter({ hasText: browserRevisionText })
    .waitFor();
  const added = await textDiff.locator('[data-change="added"]').allTextContents();
  assert.ok(added.some((line) => line.includes(browserRevisionText)));
  assert.equal(await textDiff.locator('[data-change="removed"]').count(), 0);
  await page.screenshot({ path: path.join(output, 'review-revision-diff.png'), fullPage: true });
  assert.equal((await harness.pool.query('SELECT id FROM review_decision')).rowCount, 1);
  actions.stage('当前待审运行通过后即时完成');
  await page.getByRole('button', { name: '返回审核卡', exact: true }).click();
  const approvedCurrent = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/reviews/${nextCard.id}/decision`,
  );
  await card.getByRole('button', { name: '通过', exact: true }).click();
  const currentResponse = await approvedCurrent;
  assert.equal(currentResponse.status(), 200);
  assert.equal(currentResponse.request().postDataJSON().action, 'approved');
  await card.getByText('已通过，工作区版本已冻结。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭右栏', exact: true }).click();
  const completed = page
    .getByRole('region', { name: '项目对话', exact: true })
    .getByRole('status')
    .filter({ hasText: /^已完成$/ });
  await completed.waitFor();
  assert.equal(
    (await harness.pool.query('SELECT status FROM run WHERE id=$1', [next.runId])).rows[0]?.status,
    'completed',
  );
  assert.equal(
    (
      await harness.pool.query('SELECT current_run_id FROM conversation WHERE id=$1', [
        conversationId,
      ])
    ).rows[0]?.current_run_id,
    next.runId,
  );
  assert.equal((await harness.pool.query('SELECT id FROM review_decision')).rowCount, 2);
  assert.equal((await harness.pool.query('SELECT id FROM submission_snapshot')).rowCount, 2);
  await page.screenshot({ path: path.join(output, 'review-run-completed.png'), fullPage: true });
  actions.stage('重开对话保留当前运行完成状态');
  await actions.beforeReload();
  await page.reload();
  await page.getByRole('button', { name: 'L08 510(k)', exact: true }).click();
  await page.getByRole('button', { name: `打开对话：${title}`, exact: true }).click();
  await completed.waitFor();
  // 历史首卡仍可打开；旧审核事件和卡片不能把当前已完成的第二轮退回等待。
  await page.getByRole('button', { name: '查看审核', exact: true }).first().click();
  await card.getByText('已通过，工作区版本已冻结。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭右栏', exact: true }).click();
  await completed.waitFor();
  assert.equal(
    (
      await harness.pool.query('SELECT current_run_id FROM conversation WHERE id=$1', [
        conversationId,
      ])
    ).rows[0]?.current_run_id,
    next.runId,
  );
  await page.screenshot({ path: path.join(output, 'review-run-reopened.png'), fullPage: true });
}
