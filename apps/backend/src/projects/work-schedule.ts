import { workScheduleInputSchema, workScheduleOutputSchema } from '@cert-board/shared';
import { AppError } from '../api/errors.js';

const millisecondsPerDay = 86_400_000;
const dayNumber = (date: string) => Date.parse(date) / millisecondsPerDay;
function dateOf(day: number) {
  const date = new Date(day * millisecondsPerDay).toISOString().split('T')[0]!;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date))
    throw new AppError(
      422,
      'WORK_SCHEDULE_DATE_RANGE',
      '倒排日期超出支持范围，请调整目标日期或工期。',
    );
  return date;
}

export function calculateWorkSchedule(input: unknown) {
  const schedule = workScheduleInputSchema.parse(input);
  type Node = (typeof schedule.nodes)[number];
  const byId = new Map(schedule.nodes.map((node) => [node.id, node]));
  if (byId.size !== schedule.nodes.length)
    throw new AppError(422, 'WORK_SCHEDULE_DEPENDENCY', '项目计划的节点编号不能重复。');
  const following = new Map(schedule.nodes.map(({ id }) => [id, [] as string[]]));
  for (const node of schedule.nodes) {
    const prior = new Set(node.dependsOn);
    if (prior.size !== node.dependsOn.length || node.dependsOn.some((id) => !byId.has(id)))
      throw new AppError(422, 'WORK_SCHEDULE_DEPENDENCY', '前置节点必须存在且不能重复。');
    for (const id of prior) following.get(id)!.push(node.id);
  }

  const ordered: Node[] = [];
  const active = new Set<string>();
  const complete = new Set<string>();
  function visit(node: Node) {
    if (complete.has(node.id)) return;
    if (active.has(node.id))
      throw new AppError(422, 'WORK_SCHEDULE_CYCLE', '前置关系形成环，无法计算计划。');
    active.add(node.id);
    for (const id of node.dependsOn) visit(byId.get(id)!);
    active.delete(node.id);
    complete.add(node.id);
    ordered.push(node);
  }
  for (const node of schedule.nodes) visit(node);

  type Chain = { length: number; path: string[] };
  let critical: Chain = { length: -1, path: [] };
  const chains = new Map<string, Chain>();
  for (const node of ordered) {
    let previous: Chain = { length: 0, path: [] };
    for (const id of node.dependsOn) {
      const chain = chains.get(id)!;
      if (
        chain.length > previous.length ||
        (chain.length === previous.length && chain.path.length > previous.path.length)
      )
        previous = chain;
    }
    const chain = {
      length: previous.length + node.durationDays,
      path: [...previous.path, node.id],
    };
    chains.set(node.id, chain);
    if (
      chain.length > critical.length ||
      (chain.length === critical.length && chain.path.length > critical.path.length)
    )
      critical = chain;
  }

  const latest = new Map<string, { start: number; finish: number }>();
  const target = dayNumber(schedule.targetDate);
  for (const node of ordered.toReversed()) {
    const finish = Math.min(target, ...following.get(node.id)!.map((id) => latest.get(id)!.start));
    latest.set(node.id, { start: finish - node.durationDays, finish });
  }
  const earliestFinish =
    schedule.earliestStartDate === undefined
      ? null
      : dayNumber(schedule.earliestStartDate) + critical.length;
  return workScheduleOutputSchema.parse({
    targetDate: schedule.targetDate,
    latestStartDate: dateOf(target - critical.length),
    earliestFinishDate: earliestFinish === null ? null : dateOf(earliestFinish),
    feasibility:
      earliestFinish === null
        ? 'start_unconfirmed'
        : earliestFinish <= target
          ? 'feasible'
          : 'start_too_late',
    criticalPath: critical.path,
    criticalDays: critical.length,
    nodes: ordered.map((node) => {
      const timing = latest.get(node.id)!;
      return { ...node, plannedStart: dateOf(timing.start), plannedFinish: dateOf(timing.finish) };
    }),
  });
}
