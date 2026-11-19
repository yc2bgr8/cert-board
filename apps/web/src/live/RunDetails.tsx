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
