import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { getBudgetSummary } from './service.js';
import { nanoToUsd } from './meter.js';

async function main() {
  const local = parseEnv(
    await readFile(new URL('../../../../.env.local', import.meta.url), 'utf8'),
  );
  if (!local.DATABASE_URL) throw new Error('missing_database');
  const pool = new pg.Pool({ connectionString: local.DATABASE_URL, max: 1 });
  try {
    const summary = await getBudgetSummary(pool);
    const usd = (value: string) => nanoToUsd(BigInt(value));
    console.log(
      JSON.stringify(
        {
          月份: summary.monthKey,
          整晚批次: summary.nightKey,
          单次上限美元: usd(summary.runLimitNano),
          月度上限美元: usd(summary.monthLimitNano),
          月度已计费用美元: usd(summary.monthCostNano),
          月度未结算预占美元: usd(summary.monthReservedNano),
          整晚上限美元: usd(summary.nightLimitNano),
          整晚已计费用美元: usd(summary.nightCostNano),
          整晚未结算预占美元: usd(summary.nightReservedNano),
          停止原因: summary.blockedReason,
          调用状态计数: summary.counts,
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  console.error('无法读取预算摘要，请检查本地数据库和迁移；未输出连接配置或请求内容。');
  process.exitCode = 1;
});
