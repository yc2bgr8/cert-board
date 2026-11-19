import { access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Pool } from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import type { ModelGateway } from '../modelgw/service.js';
import { callCursorAcp, checkCursorAccount } from './cursor-acp.js';
import { ExternalModels } from './service.js';
import { VerificationRooms, verificationWorkerStateId } from './verification-service.js';
import { createVerificationModerator } from './verification-moderator.js';
import type { VerificationSourceChecker } from './source-verification.js';
import {
  verificationCatalog,
  VerificationChannelError,
  type VerificationChannelStatus,
  type VerificationRuntime,
} from './verification-runtime.js';

export async function startVerificationWorker(
  pool: Pool,
  logger: Pick<FastifyBaseLogger, 'warn'>,
  environment: NodeJS.ProcessEnv,
  gateway?: Pick<ModelGateway, 'complete'>,
  checkSources?: VerificationSourceChecker,
  localReviewModelId?: string,
) {
  const bundle = environment.CERT_CURSOR_BUNDLE;
  const profileDirectory = environment.CERT_CURSOR_PROFILE;
  const permitted = environment.CERT_CURSOR_PRIVACY_CONFIRMED === '1';
  const config =
    bundle && profileDirectory && path.isAbsolute(bundle) && path.isAbsolute(profileDirectory)
      ? {
          executable: path.join(bundle, 'node.exe'),
          entrypoint: path.join(bundle, 'index.js'),
          profileDirectory,
        }
      : null;
  const workerId = randomUUID();
  let status: VerificationChannelStatus = !config
    ? 'not_installed'
    : permitted
      ? 'unavailable'
      : 'privacy_unverified';
  let checked = 0;
  let examinedRecheck = 0;
  const warn = () =>
    logger.warn({ event: 'cursor_verification_worker_error' }, '外部核实暂不可用。');
  const policy = new ExternalModels(pool, undefined, undefined, 20_000_000_000n);
  const moderator = gateway ? createVerificationModerator(pool, gateway, policy) : null;
  const checkOutbound: VerificationRuntime['checkOutbound'] =
    moderator && localReviewModelId
      ? (scope, prompt) => moderator.checkOutbound(scope, prompt, localReviewModelId)
      : undefined;
  const runtime: VerificationRuntime = {
    kind: 'cursor',
    ...(checkSources ? { checkSources } : {}),
    ...(checkOutbound ? { checkOutbound } : {}),
    get status() {
      return status;
    },
    catalog: verificationCatalog,
    async moderate(context) {
      const planned = await moderator?.moderate(context).catch(() => null);
      if (planned) return planned;
      const { eligible, attempts, activeHuman } = context;
      const model = [...eligible].sort(
        (left, right) => (attempts[left.id] ?? 0) - (attempts[right.id] ?? 0),
      )[0];
      return {
        text:
          activeHuman?.mention === 'host'
            ? '已收到你的发言，将作为人工信息单列。'
            : model
              ? `@${model.label} 请核对群里的问题和补充，给出判断和可引用的出处。`
              : '当前模型的回答已收集，开始整理。',
        call: activeHuman?.mention === 'host' ? null : (model?.id ?? null),
        finish: !model && !activeHuman,
      };
    },
    async summarize(context) {
      const conclusion = await moderator?.summarize(context).catch(() => null);
      if (conclusion) return conclusion;
      return {
        summary:
          '有出处且得到不同模型提供方支持的意见列为可信。分歧、无出处的事实和人工补充分别列出。',
        selections: {},
      };
    },
    async compact(messages, scope) {
      const compacted = await moderator?.compact(messages, scope).catch(() => null);
      if (compacted) return compacted;
      return messages
        .map(({ author, text }) => `${author}：${Array.from(text).slice(0, 80).join('')}`)
        .join('\n')
        .slice(-3800);
    },
    async send(model, prompt, beforeDispatch) {
      if (!config || !permitted || status !== 'ready')
        throw new VerificationChannelError(
          status === 'quota' || status === 'not_signed_in' || status === 'privacy_unverified'
            ? status
            : 'not_installed',
        );
      try {
        return await callCursorAcp(config, model.id, prompt, beforeDispatch);
      } catch (error) {
        if (
          error instanceof VerificationChannelError &&
          (error.code === 'not_installed' ||
            error.code === 'not_signed_in' ||
            error.code === 'privacy_unverified' ||
            error.code === 'quota')
        )
          status = error.code;
        throw error;
      }
    },
  };
  // Cursor 按次数计量，网关预算仍由独立账本负责。
  const service = new VerificationRooms(pool, policy, runtime);
  let tick: Promise<void> | undefined;
  let stopped = false;
  async function check(retryQuota: boolean) {
    if (!config || !permitted) return;
    try {
      await Promise.all([access(config.executable), access(config.entrypoint)]);
      await checkCursorAccount(config);
      if (status !== 'quota' || retryQuota) status = 'ready';
    } catch (error) {
      status =
        error instanceof VerificationChannelError &&
        error.code !== 'failed' &&
        error.code !== 'timeout'
          ? error.code
          : 'unavailable';
    }
  }
  function advance() {
    if (stopped || tick) return;
    tick = (async () => {
      const { rows } = await pool.query<{ recheck_at: Date | null }>(
        'SELECT recheck_at FROM verification_worker_state WHERE id=$1',
        [verificationWorkerStateId],
      );
      const requested = rows[0]?.recheck_at?.getTime() ?? 0;
      const retryQuota = requested > examinedRecheck;
      if (Date.now() - checked > 300000 || retryQuota) {
        checked = Date.now();
        examinedRecheck = requested;
        await check(retryQuota);
        await service.recoverWorkers();
      }
      await pool.query(
        `INSERT INTO verification_worker_state(id,worker_id,status) VALUES($1,$2,$3)
         ON CONFLICT(id) DO UPDATE SET worker_id=EXCLUDED.worker_id,status=EXCLUDED.status,updated_at=clock_timestamp()`,
        [verificationWorkerStateId, workerId, status],
      );
      await service.wakeReady(warn);
    })()
      .catch(warn)
      .finally(() => {
        tick = undefined;
      });
  }
  const timer = setInterval(advance, 1500);
  advance();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await tick;
    await service.close();
    await pool.query(
      "UPDATE verification_worker_state SET status='unavailable',updated_at=clock_timestamp() WHERE id=$1 AND worker_id=$2",
      [verificationWorkerStateId, workerId],
    );
  };
}
