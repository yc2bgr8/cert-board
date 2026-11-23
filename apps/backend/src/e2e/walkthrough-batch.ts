import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { conversationPublicEventSchema } from '@cert-board/shared';
import type { WalkthroughBatchContext } from './real-walkthrough.js';
import { nanoToUsd } from '../budget/meter.js';
import { approvedReviewReceipt } from '../goals/goal-events.js';

const primaryModel = 'openai/gpt-6.2-astra-pro';
export const registrationPrompt =
  '请用 R09 核对 L08 资料 D035 中对比器械 K 号的两种写法。请通过资料工具重新读取 D035 的原文并引用，保留不确定性，保存报告并提交审核。以前的工作区报告只供参考。';
export const maintenancePrompt =
  '请用 M02 核对三类合成年度注册档案 PREVIEW-M02-REG、PREVIEW-M02-FEE 和 PREVIEW-M02-AGENT，先通过资料工具读取实际记录，引用证据，记录待核实事项，保存并提审。';
const readPrompt =
  '只读走查。请先通过工具读取项目资料，简要说明其中已核实的一项和仍待核实的一项。不要送审、改文件或发消息。';
const deadline = 16 * 60_000;

type Proof = { conversationIds: string[]; verificationIds: string[]; resampledRuns?: string[] };
type Scene = { name: string; run(proof: Proof, folder: string): Promise<void> };
type SceneResult = Proof & { name: string; passed: boolean; problem: string | null };

class SceneError extends Error {}

function requireProof(value: unknown, code: string): asserts value {
  if (!value) throw new SceneError(code);
}

export function confirmsReviewApproval(reply: string) {
  return reply === approvedReviewReceipt;
}

async function until<T>(
  inspect: () => Promise<T | undefined>,
  code: string,
  window = deadline,
): Promise<T> {
  const end = Date.now() + window;
  while (Date.now() < end) {
    const result = await inspect();
    if (result !== undefined) return result;
    await delay(500);
  }
  throw new SceneError(code);
}

export function batchScenes(ctx: WalkthroughBatchContext): Scene[] {
  const { page, pool, browserContext, origin, registrationProject, maintenanceProject } = ctx;
  const scenes: Scene[] = [];
  const open = async (
    proof: Proof,
    title: string,
    mode: 'ask' | 'full' | 'read_only',
    project = registrationProject,
    tab = page,
  ) => {
    const id = await ctx.openConversation(tab, project, `Q2 ${title}`, mode);
    proof.conversationIds.push(id);
    return id;
  };
  const runStatus = async (
    id: string,
    expected = 'completed',
    approvalOnly = false,
    window = deadline,
  ) => {
    await until(
      async () => {
        const row = (
          await pool.query<{ status: string }>('SELECT status FROM run WHERE id=$1', [id])
        ).rows[0];
        if (row?.status === expected) return true;
        if (approvalOnly && row?.status === 'stopped') {
          const boundary = await pool.query(
            `SELECT 1 FROM conversation_event WHERE run_id=$1 AND type='run_status'
           AND payload_json->>'reasonCode'='REVIEW_NOT_SUBMITTED'`,
            [id],
          );
          if (boundary.rowCount) return true;
        }
        if (row && ['completed', 'failed', 'stopped', 'budget_exhausted'].includes(row.status))
          throw new SceneError(`运行未达预期 ${id} ${row.status}`);
        return undefined;
      },
      `运行超时 ${id}`,
      window,
    );
  };
  const didRead = async (runId: string) => {
    const read = await pool.query(
      "SELECT 1 FROM tool_invocation WHERE run_id=$1 AND tool_name='doc_read' AND status='completed'",
      [runId],
    );
    requireProof(read.rowCount, `未完成资料读取 ${runId}`);
  };
  const reviewFollowUp = async (card: string) => {
    const run = await until(
      async () => {
        const result = await pool.query<{ run_id: string }>(
          `SELECT e.wake_run_id AS run_id FROM goal_event e JOIN review_decision d ON d.id::text=e.source_key
         WHERE e.source='review_decision' AND d.card_id=$1 AND d.action='approved'
           AND e.wake_run_id IS NOT NULL`,
          [card],
        );
        return result.rows[0]?.run_id;
      },
      `审核后未续跑 ${card}`,
      120_000,
    );
    await runStatus(run);
    const { rows } = await pool.query<{ reply: string }>(
      `SELECT m.message_json->>'content' AS reply FROM conversation_message m JOIN run r ON r.id=m.run_id
       WHERE r.id=$1 AND m.message_json->>'role'='assistant'
         AND NOT EXISTS (SELECT 1 FROM tool_invocation WHERE run_id=$1)
         AND NOT EXISTS (SELECT 1 FROM review_card WHERE run_id=$1)
         AND NOT EXISTS (SELECT 1 FROM workspace_draft draft
           WHERE draft.conversation_id=r.conversation_id AND draft.updated_at>=r.created_at)
       ORDER BY m.seq DESC LIMIT 1`,
      [run],
    );
    const reply = rows[0]?.reply;
    requireProof(
      reply && confirmsReviewApproval(reply),
      `审核后的续跑未按原对话直接确认决定 ${run}`,
    );
  };

  const reconnectConversation = async (proof: Proof) => {
    const observed = new Map<string, { requestId: string; content: string }>();
    const streams = new Map<string, string>();
    const network = await browserContext.newCDPSession(page);
    try {
      await network.send('Network.enable');
      network.on('Network.responseReceived', ({ requestId, response }) => {
        const url = new URL(response.url);
        if (
          url.origin === origin &&
          response.status === 200 &&
          response.mimeType === 'text/event-stream'
        )
          streams.set(requestId, url.pathname);
      });
      const id = await open(proof, '事件流重连', 'read_only');
      const eventsPath = `/api/conversations/${id}/events`;
      const route = `**${eventsPath}*`;
      const reconnect = page
        .getByRole('region', { name: '项目对话', exact: true })
        .getByRole('button', { name: '重新连接', exact: true });
      network.on('Network.eventSourceMessageReceived', ({ eventName, data, requestId }) => {
        if (eventName !== 'user_message') return;
        try {
          const parsed = conversationPublicEventSchema.safeParse(JSON.parse(data));
          if (
            parsed.success &&
            parsed.data.type === 'user_message' &&
            parsed.data.conversationId === id
          )
            observed.set(parsed.data.runId, { requestId, content: parsed.data.payload.content });
        } catch {
          // 格式错误的事件没有有效回执，由走查超时记录。
        }
      });
      const received = (runId: string, content: string) =>
        until(
          async () => {
            const event = observed.get(runId);
            return event?.content === content && streams.get(event.requestId) === eventsPath
              ? event.requestId
              : undefined;
          },
          `接收页未从事件流读到用户消息 ${runId}`,
          30_000,
        );

      const beforePrompt = `${readPrompt} 这是断线前的任务。`;
      const before = await ctx.send(page, beforePrompt);
      const originalStream = await received(before.runId, beforePrompt);
      await page.getByText(beforePrompt, { exact: true }).waitFor();
      await runStatus(before.runId);
      await page
        .getByRole('status')
        .filter({ hasText: /^已完成$/u })
        .waitFor();
      const originalDocument = await page.evaluate(() => performance.timeOrigin);
      let run: Awaited<ReturnType<WalkthroughBatchContext['send']>>;
      await page.route(route, (request) => request.abort());
      try {
        await page.evaluate(() => window.stop());
        await reconnect.waitFor();
        const sender = await browserContext.newPage();
        try {
          await sender.goto(`${origin}/?conversation=${id}`);
          run = await ctx.send(sender, readPrompt);
        } finally {
          await sender.close();
        }
        requireProof(
          !observed.has(run.runId) &&
            (await page.getByText(readPrompt, { exact: true }).count()) === 0,
          '断线浏览器已经收到其他标签页的新消息',
        );
      } finally {
        await page.unroute(route);
      }
      await reconnect.click();
      const restoredStream = await received(run.runId, readPrompt);
      requireProof(restoredStream !== originalStream, '未通过新事件流补收断线期间的消息');
      await runStatus(run.runId);
      await didRead(run.runId);
      await page
        .getByRole('status')
        .filter({ hasText: /^已完成$/u })
        .waitFor();
      const replayed = page.getByText(readPrompt, { exact: true });
      await replayed.waitFor();
      requireProof((await replayed.count()) === 1, '重连后用户消息重复');
      requireProof(
        (await page.evaluate(() => performance.timeOrigin)) === originalDocument,
        '重连收到消息和完成状态时原页面已被重新加载',
      );
    } finally {
      await network.detach();
    }
  };

  const refreshDuringRun = async (proof: Proof) => {
    const end = Date.now() + deadline;
    const remaining = () => {
      const ms = end - Date.now();
      requireProof(ms > 0, '运行中刷新走查已到截止时间');
      return ms;
    };
    const processing = page.getByRole('status').filter({ hasText: /^正在处理$/u });
    const currentStatus = (id: string, runId: string) =>
      until(
        async () => {
          const { rows } = await pool.query<{ status: string }>(
            `SELECT r.status FROM conversation c JOIN run r ON r.id=c.current_run_id
           WHERE c.id=$1 AND r.id=$2`,
            [id, runId],
          );
          const status = rows[0]?.status;
          if (status === 'completed') return status;
          if (status === 'running' && (await processing.isVisible())) return status;
          if (status && !['queued', 'running'].includes(status))
            throw new SceneError(`刷新场景的同一运行未正常执行 ${runId} ${status}`);
          return undefined;
        },
        `刷新场景没有显示同一运行正在处理 ${runId}`,
        Math.min(remaining(), 30_000),
      );
    for (let attempt = 0; attempt < 2; attempt++) {
      remaining();
      const id = await open(proof, '运行中刷新', 'read_only');
      remaining();
      const run = await ctx.send(page, readPrompt);
      if ((await currentStatus(id, run.runId)) === 'running') {
        await page.reload({
          waitUntil: 'domcontentloaded',
          timeout: Math.min(remaining(), 30_000),
        });
        if ((await currentStatus(id, run.runId)) === 'running') {
          await runStatus(run.runId, 'completed', false, remaining());
          await didRead(run.runId);
          await page
            .getByRole('status')
            .filter({ hasText: /^已完成$/u })
            .waitFor({ timeout: remaining() });
          const submitted = page.getByText(readPrompt, { exact: true });
          await submitted.waitFor({ timeout: remaining() });
          requireProof((await submitted.count()) === 1, '刷新后用户消息重复');
          remaining();
          return;
        }
      }
      await page
        .getByRole('status')
        .filter({ hasText: /^已完成$/u })
        .waitFor({ timeout: remaining() });
      await didRead(run.runId);
      (proof.resampledRuns ??= []).push(run.runId);
    }
    throw new SceneError('两次采样均正常结束，未能验证运行中的刷新恢复');
  };

  for (const skill of ['R09', 'M02'] as const) {
    const count = skill === 'R09' ? 6 : 4;
    for (let index = 0; index < count; index++) {
      const mode = index % 2 === 0 ? 'ask' : 'full';
      const revised = skill === 'R09' && index >= 2;
      const name = `${skill} ${index + 1} ${mode === 'ask' ? '请求批准' : '完全允许'}${revised ? '及重提' : ''}`;
      scenes.push({
        name,
        run: async (proof, folder) => {
          const conversation = await open(
            proof,
            name,
            mode,
            skill === 'R09' ? registrationProject : maintenanceProject,
          );
          await ctx.send(page, skill === 'R09' ? registrationPrompt : maintenancePrompt);
          let card = await ctx.waitForReview(page, pool, conversation, 1);
          const first = await ctx.inspectSubmission(pool, card, skill);
          if (revised) {
            await ctx.review(page, pool, card, path.join(folder, 'initial.png'), false);
            await ctx.send(
              page,
              '请修改原路径的 Markdown 报告，分别修改“核查范围”“已核实”“待核实”三个小节的正文，然后保存并重新提审。',
            );
            card = await ctx.waitForReview(page, pool, conversation, 2);
            await ctx.verifyRevision(pool, ctx.blobs, card, first);
          }
          await ctx.review(page, pool, card, path.join(folder, 'review.png'), true);
          await ctx.verifyTools(pool, conversation);
          await reviewFollowUp(card);
        },
      });
    }
  }

  for (const [index, action] of ['拒绝', '允许', '本对话中都允许', '拒绝'].entries()) {
    const name = `过程审批 ${index + 1} ${action}`;
    scenes.push({
      name,
      run: async (proof, folder) => {
        await open(proof, name, 'ask');
        // 只绑定验收库中的开发账号，业务工具只接受 local_test 通道。
        const contact = await pool.query<{ id: string }>(
          `INSERT INTO contact(project_id,name,address,source,created_by,internal_user_id)
         SELECT $1,'合成走查联系人',$2,'Q2 独立验收临时绑定',a.id,b.id FROM app_user a CROSS JOIN app_user b
           WHERE a.username='zhangsan' AND a.is_development AND b.username=$3 AND b.is_development RETURNING id`,
          [
            registrationProject,
            `local-test-q2-${randomUUID()}`,
            action === '本对话中都允许' ? 'admin' : 'wangmin',
          ],
        );
        requireProof(contact.rows[0], '验收库缺少合成账号');
        const sent = await ctx.send(
          page,
          `请用 queue_internal_message 对编号 ${contact.rows[0].id} 的合成走查联系人提出一条本地测试提醒，主题“核查合成资料”，内容“请核查合成资料”。等我的浏览器批准。`,
        );
        const button = page
          .getByRole('region', { name: '批准请求', exact: true })
          .getByRole('button', { name: action, exact: true });
        await button.waitFor({ timeout: 120_000 });
        const queue = () =>
          pool.query(
            "SELECT 1 FROM internal_outbound_message WHERE run_id=$1 AND channel='local_test'",
            [sent.runId],
          );
        requireProof((await queue()).rowCount === 0, `审批前已产生队列 ${sent.runId}`);
        const response = page.waitForResponse(
          (value) =>
            value.request().method() === 'POST' &&
            /^\/api\/approvals\/[^/]+$/u.test(new URL(value.url()).pathname),
        );
        await button.click();
        requireProof((await response).ok(), `审核接口拒绝 ${sent.runId}`);
        const decision = await pool.query<{ action: string }>(
          'SELECT d.action FROM tool_approval_decision d JOIN tool_approval a ON a.id=d.approval_id WHERE a.run_id=$1',
          [sent.runId],
        );
        const expected = {
          拒绝: 'reject',
          允许: 'allow_once',
          本对话中都允许: 'allow_conversation',
        }[action];
        requireProof(decision.rows[0]?.action === expected, `审批记录不符 ${sent.runId}`);
        if (action === '拒绝') {
          await runStatus(sent.runId, 'completed', true);
          requireProof((await queue()).rowCount === 0, `拒绝后产生队列 ${sent.runId}`);
        } else {
          await until(
            async () => ((await queue()).rowCount === 1 ? true : undefined),
            `允许后未产生测试队列 ${sent.runId}`,
            120_000,
          );
          await runStatus(sent.runId, 'completed', true);
        }
        await page.screenshot({ path: path.join(folder, 'approval.png') });
      },
    });
  }

  for (const [index, kind] of ['插话', '停止后新轮', '提问回复', '插话'].entries()) {
    const name = `对话控制 ${index + 1} ${kind}`;
    scenes.push({
      name,
      run: async (proof) => {
        await open(proof, name, 'read_only');
        if (kind === '提问回复') {
          const first = await ctx.send(
            page,
            '缺少本次只读核查的范围。请先用 ask_user 询问要核查哪一类资料，等待我的回复。',
          );
          await page
            .getByRole('button', { name: '回复', exact: true })
            .waitFor({ timeout: 120_000 });
          const answered = await ctx.send(
            page,
            '请核查项目中可读的申报资料，只读并概述依据。',
            '回复',
          );
          await runStatus(answered.runId);
          requireProof(first.runId && answered.runId, '提问回复缺少执行编号');
          return;
        }
        const first = await ctx.send(page, readPrompt);
        if (kind === '插话') {
          const note = '补充要求：请明确区分原文与推断，并继续只读核查。';
          const added = await ctx.send(page, note, '插话');
          requireProof(
            added.kind === 'steering' && added.runId === first.runId,
            '插话未进入同一轮',
          );
          await runStatus(first.runId);
          const delivered = await pool.query(
            'SELECT 1 FROM run_steering_message WHERE run_id=$1 AND delivered_at IS NOT NULL',
            [first.runId],
          );
          requireProof(delivered.rowCount === 1, `插话没有恰好送达一次 ${first.runId}`);
        } else {
          await until(
            async () => {
              const model = await pool.query(
                "SELECT 1 FROM run_event WHERE run_id=$1 AND type='model_started'",
                [first.runId],
              );
              return model.rowCount ? true : undefined;
            },
            `停止前模型未启动 ${first.runId}`,
            90_000,
          );
          await page.getByRole('button', { name: '停止', exact: true }).click();
          await runStatus(first.runId, 'stopped');
          const next = await ctx.send(page, readPrompt);
          requireProof(next.runId !== first.runId, '停止后未启动新轮');
          await runStatus(next.runId);
          await didRead(next.runId);
        }
      },
    });
  }

  for (let index = 1; index <= 3; index++) {
    scenes.push({
      name: `合成外部双通道核实 ${index}`,
      run: async (proof, folder) => {
        await ctx.exerciseVerification(page, pool, folder, (id) => proof.verificationIds.push(id));
      },
    });
  }

  for (const kind of ['错误页恢复', '消息失败重试', '运行中刷新', '事件流重连']) {
    const name = kind;
    scenes.push({
      name,
      run: async (proof) => {
        if (kind === '事件流重连') return reconnectConversation(proof);
        if (kind === '运行中刷新') return refreshDuringRun(proof);
        const id = await open(proof, name, 'read_only');
        if (kind === '错误页恢复') {
          await page.goto(`${origin}/?conversation=${randomUUID()}`);
          await page
            .getByRole('alert')
            .filter({ hasText: /错误编号/u })
            .waitFor();
          await page.goto(`${origin}/?conversation=${id}`);
        }
        if (kind === '消息失败重试') {
          const route = `**/api/conversations/${id}/messages`;
          await page.route(route, async (request) => {
            if (request.request().method() === 'POST') await request.abort();
            else await request.fallback();
          });
          try {
            await page.getByRole('textbox', { name: '消息', exact: true }).fill(readPrompt);
            await page.getByRole('button', { name: '发送', exact: true }).click();
            await page
              .getByRole('alert')
              .filter({ hasText: /错误编号/u })
              .waitFor();
          } finally {
            await page.unroute(route);
          }
        }
        const run = await ctx.send(page, readPrompt);
        await runStatus(run.runId);
        await didRead(run.runId);
        await page.getByText(readPrompt, { exact: true }).waitFor();
        requireProof(
          (await page.getByText(readPrompt, { exact: true }).count()) === 1,
          '恢复后用户消息重复',
        );
      },
    });
  }

  for (let index = 1; index <= 5; index++) {
    const name = `双对话并发 ${index}`;
    scenes.push({
      name,
      run: async (proof) => {
        const secondPage = await browserContext.newPage();
        try {
          await secondPage.goto(origin);
          await open(proof, `${name} A`, 'read_only');
          await open(proof, `${name} B`, 'read_only', maintenanceProject, secondPage);
          const [a, b] = await Promise.all([
            ctx.send(page, readPrompt),
            ctx.send(secondPage, readPrompt),
          ]);
          requireProof(a.runId !== b.runId, '双对话使用同一运行');
          await Promise.all([runStatus(a.runId), runStatus(b.runId)]);
          await Promise.all([didRead(a.runId), didRead(b.runId)]);
          const { rows } = await pool.query<{ start: Date; finish: Date }>(
            `SELECT min(started.created_at) AS start, r.finished_at AS finish
           FROM run r JOIN conversation_event started ON started.run_id=r.id
           WHERE r.id=ANY($1::uuid[]) AND started.type='run_status'
             AND started.payload_json->>'status'='running'
             AND r.status='completed' AND r.finished_at IS NOT NULL
           GROUP BY r.id`,
            [[a.runId, b.runId]],
          );
          const [first, second] = rows;
          requireProof(first && second, '并发走查缺少两条运行的起止时间');
          requireProof(
            first.start < second.finish && second.start < first.finish,
            '两个运行没有实际重叠',
          );
        } finally {
          await secondPage.close();
        }
      },
    });
  }
  return scenes;
}

export function batchHasPassed(results: readonly SceneResult[], blockedRequests: number) {
  const ids = results.flatMap(({ conversationIds, verificationIds }) => [
    ...conversationIds,
    ...verificationIds,
  ]);
  return (
    blockedRequests === 0 && results.every((row) => row.passed) && new Set(ids).size === ids.length
  );
}

export async function exerciseBatch(ctx: WalkthroughBatchContext) {
  const startedAt = new Date();
  const cases = batchScenes(ctx);
  requireProof(cases.length >= 30, '走查场景少于三十个');
  const results: SceneResult[] = [];
  for (const [index, scene] of cases.entries()) {
    const folder = path.join(ctx.evidenceFolder, `q2-${String(index + 1).padStart(2, '0')}`);
    await mkdir(folder, { recursive: true });
    const proof: Proof = { conversationIds: [], verificationIds: [] };
    let problem: string | null = null;
    try {
      await scene.run(proof, folder);
      requireProof(
        proof.conversationIds.length || proof.verificationIds.length,
        '场景缺少独立对话或核实编号',
      );
      for (const id of proof.conversationIds) {
        const usage = await ctx.pool.query(
          "SELECT 1 FROM usage_ledger WHERE conversation_id=$1 AND model_id=$2 AND status='settled' LIMIT 1",
          [id, primaryModel],
        );
        requireProof(usage.rowCount, `缺少旗舰模型计量 ${id}`);
      }
    } catch (error) {
      problem =
        error instanceof SceneError
          ? error.message
          : error instanceof Error && error.name === 'TimeoutError'
            ? '浏览器等待超时'
            : '场景断言或页面操作失败';
      await ctx.page.screenshot({ path: path.join(folder, 'failure.png') }).catch(() => undefined);
    }
    results.push({ name: scene.name, ...proof, passed: problem === null, problem });
    await writeFile(
      path.join(ctx.evidenceFolder, 'q2-cases.json'),
      JSON.stringify(results, null, 2),
    );
    console.log(`Q2 ${index + 1}/${cases.length} ${scene.name} ${problem ? '失败' : '通过'}`);
    await ctx.page.goto(ctx.origin);
  }
  const usage = await ctx.pool.query<{
    model: string;
    paid: string;
    pending: number;
    calls: number;
  }>(
    `SELECT model_id AS model,COALESCE(sum(actual_nano) FILTER(WHERE status='settled'),0)::text AS paid,
     COUNT(*) FILTER(WHERE status IN ('unknown','reserved'))::int AS pending,COUNT(*)::int AS calls
     FROM usage_ledger WHERE created_at >= $1 GROUP BY model_id ORDER BY model_id`,
    [startedAt],
  );
  await ctx.browserContext.close();
  const rejectedRequests = ctx.blockedRequestCount();
  const passed = batchHasPassed(results, rejectedRequests);
  await writeFile(
    path.join(ctx.evidenceFolder, 'q2-result.json'),
    JSON.stringify(
      {
        status: passed ? 'passed' : 'failed',
        commit: process.env.CERT_WALKTHROUGH_COMMIT,
        instance: process.env.CERT_WALKTHROUGH_INSTANCE,
        blockedRequests: rejectedRequests,
        cases: results,
        cost: usage.rows.map(({ paid, ...rest }) => ({ ...rest, usd: nanoToUsd(BigInt(paid)) })),
      },
      null,
      2,
    ),
  );
  requireProof(passed, rejectedRequests ? '浏览器尝试发送非本站请求' : '多场走查仍有未通过项');
}
