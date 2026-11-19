import { readFile } from 'node:fs/promises';
import { parseArgs, parseEnv } from 'node:util';
import pg from 'pg';
import { budgetEnvironmentSchema } from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { getBudgetSummary, reconcileUsage } from './service.js';
import { nanoToUsd, usdToNano } from './meter.js';

const isReconcile = process.argv[2] === 'reconcile';
const usd = (value: string) => nanoToUsd(BigInt(value));

function reconcileArguments(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean' },
      'ledger-id': { type: 'string' },
      outcome: { type: 'string' },
      evidence: { type: 'string' },
      'actual-usd': { type: 'string' },
      'input-tokens': { type: 'string' },
      'cache-read-tokens': { type: 'string' },
      'output-tokens': { type: 'string' },
    },
  });
  const tokenCount = (value: string) => (/^(?:0|[1-9][0-9]*)$/.test(value) ? Number(value) : NaN);
  return {
    help: values.help ?? false,
    input: {
      ledgerId: values['ledger-id'],
      outcome: values.outcome,
      evidence: values.evidence,
      ...(values['actual-usd'] !== undefined
        ? { actualCostNano: usdToNano(values['actual-usd']).toString() }
        : {}),
      ...(values['input-tokens'] !== undefined
        ? { inputTokens: tokenCount(values['input-tokens']) }
        : {}),
      ...(values['cache-read-tokens'] !== undefined
        ? { cacheReadTokens: tokenCount(values['cache-read-tokens']) }
        : {}),
      ...(values['output-tokens'] !== undefined
        ? { outputTokens: tokenCount(values['output-tokens']) }
        : {}),
    },
  };
}

async function main() {
  const reconciliation = isReconcile ? reconcileArguments(process.argv.slice(3)) : null;
  if (reconciliation?.help) {
    console.log(
      'pnpm budget:reconcile --ledger-id <编号> --outcome <charged|not_sent|reserved_estimate> --evidence <依据>\n' +
        'charged 另需 --actual-usd、--input-tokens、--cache-read-tokens、--output-tokens。',
    );
    return;
  }
  const local = parseEnv(
    await readFile(new URL('../../../../.env.local', import.meta.url), 'utf8'),
  );
  if (!local.DATABASE_URL) throw new Error('missing_database');
  if (reconciliation) process.env.NODE_ENV = budgetEnvironmentSchema.parse(local.NODE_ENV);
  const pool = new pg.Pool({ connectionString: local.DATABASE_URL, max: 1 });
  try {
    if (reconciliation) {
      const receipt = await reconcileUsage(pool, reconciliation.input);
      console.log(
        JSON.stringify(
          {
            账本编号: receipt.ledgerId,
            核账结果: receipt.outcome,
            核账计费美元: usd(receipt.costNano),
            停止原因: receipt.blockedReason,
          重复核账: receipt.replayed,
          },
          null,
          2,
        ),
      );
      return;
    }
    const summary = await getBudgetSummary(pool);
    console.log(
      JSON.stringify(
        {
          月份: summary.monthKey,
          整晚批次: summary.nightKey,
          单次上限美元: usd(summary.runLimitNano),
          月度上限美元: usd(summary.monthLimitNano),
          月度已计费用美元: usd(summary.monthCostNano),
          月度其中按预占计费美元: usd(summary.monthEstimatedNano),
          月度未结算预占美元: usd(summary.monthReservedNano),
          整晚上限美元: usd(summary.nightLimitNano),
          整晚已计费用美元: usd(summary.nightCostNano),
          整晚其中按预占计费美元: usd(summary.nightEstimatedNano),
          整晚未结算预占美元: usd(summary.nightReservedNano),
          停止原因: summary.blockedReason,
          调用状态计数: summary.counts,
          按预占计费条数: summary.settledEstimatedCount,
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof AppError
      ? error.message
      : isReconcile
        ? '核账未完成，请检查命令参数、本地数据库和迁移。'
        : '无法读取预算摘要，请检查本地数据库和迁移。',
  );
  process.exitCode = 1;
});
