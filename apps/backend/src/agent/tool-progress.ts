import { z } from 'zod';

const labels: Readonly<Record<string, string>> = {
  cert_context: '读取项目与当前目标',
  skill_load: '查看技能工作方法',
  doc_search: '检索项目资料',
  doc_read: '读取资料原文',
  code_run: '在沙箱运行代码',
  code_run_save: '运行代码并保存产出',
  ws_list: '列出工作区文件',
  ws_read: '读取工作区文件',
  ws_search: '查找工作区文件内容',
  ws_write: '写入工作副本',
  ws_edit: '编辑工作副本',
  workspace_save: '保存工作区版本',
  workspace_restore: '恢复工作区版本',
  workspace_rebase: '合并工作区版本',
  check_run: '核对原文和提交结构',
  plan_update: '更新任务计划',
  ask_user: '等待发起人回答',
  submit_for_review: '提交审核',
  propose_external: '登记外发提案',
  queue_internal_message: '登记内部测试消息',
  consult_external_model: '请外部模型核实',
  web_search: '检索公开网页',
  web_fetch: '抓取并保存网页出处',
  deadline_calc: '计算法域期限',
  reminder_set: '设置站内期限提醒',
};

const page = z.object({
  sourceKey: z.string().max(128),
  version: z.number().int().positive(),
  page: z.number().int().positive(),
  locatorKind: z.enum(['physical_page', 'extraction_unit']),
  truncated: z.boolean(),
});
const matches = z.object({ items: z.array(z.unknown()).max(30), hasMore: z.boolean() });
const approval = z.object({ approvalId: z.string().uuid(), status: z.literal('pending') });
const sandboxStatus = z.object({
  status: z.enum(['ok', 'timed_out', 'memory_limit', 'failed']),
  saveStatus: z.enum(['temporary', 'saved', 'skipped']).optional(),
});

export function toolLabel(name: string) {
  return labels[name] ?? '执行登记工具';
}

export function toolSummary(name: string, data: unknown, isError: boolean): string {
  if (isError) return `${toolLabel(name)}未完成`;
  if (approval.safeParse(data).success) return '等待发起人在浏览器批准后继续';
  if (name === 'code_run' || name === 'code_run_save') {
    const parsed = sandboxStatus.safeParse(data);
    if (parsed.success) {
      if (parsed.data.status === 'timed_out') return '沙箱到达运行时限，已终止程序';
      if (parsed.data.status === 'memory_limit') return '沙箱达到内存上限，已终止程序';
      if (parsed.data.status === 'failed') return '沙箱程序执行失败';
      if (parsed.data.saveStatus === 'skipped') return '沙箱已运行，未保存产出';
    }
  }
  if (name === 'doc_read') {
    const parsed = page.safeParse(data);
    if (parsed.success) {
      const { sourceKey, version, page: pageNumber, locatorKind, truncated } = parsed.data;
      const location = locatorKind === 'physical_page' ? '页' : '提取单元';
      return `已读 ${sourceKey} 第 ${version} 版，第 ${pageNumber} ${location}${truncated ? '，还有内容可继续读取' : ''}`;
    }
  }
  if (name === 'doc_search') {
    const parsed = matches.safeParse(data);
    if (parsed.success)
      return `检索返回 ${parsed.data.items.length} 个资料位置${parsed.data.hasMore ? '，还有后续结果' : ''}`;
  }
  if (name === 'queue_internal_message') return '已排入内部本地测试队列';
  if (
    (name === 'web_fetch' || name === 'web_search') &&
    z.object({ status: z.literal('unavailable') }).safeParse(data).success
  )
    return '网页操作未完成，已返回核实提示';
  if (name === 'consult_external_model') {
    const result = z.object({ status: z.enum(['completed', 'unavailable']) }).safeParse(data);
    return result.success && result.data.status === 'unavailable'
      ? '核实暂不可用，继续核对项目资料'
      : '已取得外部核实结论';
  }
  if (name === 'ask_user') return toolLabel(name);
  return `${toolLabel(name)}已完成`;
}
