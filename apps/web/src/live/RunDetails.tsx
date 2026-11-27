import type { PublicCertQueryReceipt } from '@cert-board/shared';
import type { LiveRun } from './events.js';
import { toolStateNames } from './InlineExecution.js';

export const runStateNames: Record<LiveRun['status'], string> = {
  queued: '等待开始',
  running: '正在处理',
  waiting: '等待处理',
  completed: '已完成',
  failed: '运行失败',
  stopped: '已停止',
  budget_exhausted: '预算检查已停止本轮',
};

const clock = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const dateTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const queryNames: Record<PublicCertQueryReceipt['template'], string> = {
  credentials_expiring: '即将到期的证照',
  model_market_status: '型号市场状态',
  market_sellable_models: '市场可售型号',
  overdue_milestones: '逾期节点',
  pending_my_reviews: '待我审核',
  unsupported: '目录无匹配模板',
};
const queryStatuses: Record<PublicCertQueryReceipt['status'], string> = {
  complete: '完整',
  partial: '部分',
  unanswerable: '无法回答',
};
const queryGaps: Record<PublicCertQueryReceipt['gaps'][number], string> = {
  template_unavailable: '查询模板不可用',
  project_required: '请指定项目',
  subject_unverified: '查询对象待核对',
  coverage_unverified: '台账覆盖范围待核验',
  records_incomplete: '台账记录不完整',
  results_truncated: '结果已截断，最多返回 100 条',
};

function QueryReceipt({ receipt }: { receipt: PublicCertQueryReceipt }) {
  return (
    <div role="group" aria-label="台账查询回执">
      <dl>
        <dt>查询</dt>
        <dd>{queryNames[receipt.template]}</dd>
        <dt>可回答性</dt>
        <dd>{queryStatuses[receipt.status]}</dd>
        <dt>范围</dt>
        <dd>{receipt.scope === 'project' ? '当前项目' : '部门台账'}</dd>
        <dt>目录版本</dt>
        <dd>{receipt.catalogVersion}</dd>
        <dt>查询时间</dt>
        <dd>
          <time dateTime={receipt.asOf}>{dateTime.format(new Date(receipt.asOf))}</time>
        </dd>
        {receipt.method && (
          <>
            <dt>口径</dt>
            <dd>{receipt.method}</dd>
          </>
        )}
        {receipt.gaps.length > 0 && (
          <>
            <dt>数据缺口</dt>
            <dd>{receipt.gaps.map((gap) => queryGaps[gap]).join('、')}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

export function RunDetails({ run }: { run: LiveRun }) {
  const completed = run.tools.filter((tool) => tool.status === 'completed').length;
  const stopped = run.status === 'stopped' || run.status === 'budget_exhausted';
  return (
    <div className="live-run-details">
      <section aria-label="运行概况">
        <h3>运行状态</h3>
        <dl>
          <dt>状态</dt>
          <dd>{runStateNames[run.status]}</dd>
          <dt>开始</dt>
          <dd>
            <time dateTime={run.startedAt}>{clock.format(new Date(run.startedAt))}</time>
          </dd>
          <dt>最近更新</dt>
          <dd>
            <time dateTime={run.updatedAt}>{clock.format(new Date(run.updatedAt))}</time>
          </dd>
          <dt>已完成工具步骤</dt>
          <dd>
            {completed} / {run.tools.length}
          </dd>
        </dl>
        {run.summary && run.summary !== '运行状态已更新。' && <p>{run.summary}</p>}
      </section>
      {run.plan && (
        <section aria-label="最近计划">
          <h3>最近计划</h3>
          <p>{run.plan.progress}</p>
          <ol>
            {run.plan.steps.map((step, index) => (
              <li key={index}>
                {step.title} ·{' '}
                {
                  {
                    pending: '待处理',
                    running: stopped ? '停止时进行中' : '进行中',
                    completed: '完成',
                  }[step.status]
                }
              </li>
            ))}
          </ol>
        </section>
      )}
      <section aria-label="工具步骤时间线">
        <h3>工具步骤时间线</h3>
        {run.tools.length ? (
          <ol className="live-run-timeline">
            {run.tools.map((tool) => (
              <li key={tool.id}>
                <time dateTime={tool.createdAt}>{clock.format(new Date(tool.createdAt))}</time>
                <p>
                  {tool.summary || tool.name} · {toolStateNames[tool.status]}
                </p>
                {tool.certQuery && <QueryReceipt receipt={tool.certQuery} />}
              </li>
            ))}
          </ol>
        ) : (
          <p>本次运行尚无工具步骤。</p>
        )}
      </section>
    </div>
  );
}
