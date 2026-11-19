import { defaultPermissionMode, type PermissionMode } from '@cert-board/shared';

export type ProjectKey = 'registration' | 'maintenance';
export type Permission = PermissionMode;
export type Phase =
  | 'ready'
  | 'reading'
  | 'approval'
  | 'finishing'
  | 'review'
  | 'approved'
  | 'rejected'
  | 'returned'
  | 'stopped'
  | 'read_complete'
  | 'transferred';
export type ChatEntry = { id: number; role: 'user' | 'agent'; text: string };
export type Thread = {
  phase: Phase;
  permission: Permission;
  draft: string;
  messages: ChatEntry[];
  version: number;
  token: number;
  startedAt: number;
  elapsed: number;
  processCount: number;
  allowed: boolean;
  onceAllowed: boolean;
  conservative: boolean;
  feedback: Record<number, string>;
};
export type Source = { id: string; name: string; page: number; text: string; quote: string };
export const sources: Record<ProjectKey, Source[]> = {
  registration: [
    {
      id: 'REG-01',
      name: '对比器械对照表',
      page: 2,
      text: 'Device comparison\nPredicate device 510(k) number: K123456.\nThe predicate identifier is listed in the device comparison table.',
      quote: 'Predicate device 510(k) number: K123456.',
    },
    {
      id: 'REG-02',
      name: '510(k)摘要',
      page: 4,
      text: 'Submission summary\nPredicate device 510(k) number: K123465.\nThe predicate identifier is repeated in the submission summary.',
      quote: 'Predicate device 510(k) number: K123465.',
    },
  ],
  maintenance: [
    {
      id: 'MAINT-01',
      name: '企业注册记录',
      page: 1,
      text: '企业注册记录\n企业注册状态：已登记。\n适用年度：等待核对。',
      quote: '适用年度：等待核对。',
    },
    {
      id: 'MAINT-02',
      name: '年费付款凭据',
      page: 1,
      text: '年费付款凭据\n付款状态：已留存凭据。\n付款年度与金额：等待核对原件。',
      quote: '付款年度与金额：等待核对原件。',
    },
    {
      id: 'MAINT-03',
      name: '美国代理人协议',
      page: 1,
      text: '美国代理人协议\n联系人：王敏。\n协议有效期：等待核对签署页。',
      quote: '协议有效期：等待核对签署页。',
    },
  ],
};
export const projects = {
  registration: {
    name: 'L08 510(k)',
    agent: '注册Agent',
    conversation: 'K号写法检查',
    task: '检查对比器械K号写法',
    prompt: '检查L08申报资料中对比器械K号的写法',
    filename: '对比器械K号核查记录.md',
    plan: [
      '读取项目说明与 R09 技能',
      '对照两处原文中的 K 号',
      '记录判断和候选改动',
      '自检后提交审核',
    ],
  },
  maintenance: {
    name: 'L08 年度注册',
    agent: '维护Agent',
    conversation: '年度注册核查',
    task: '核查年度注册资料',
    prompt: '核查L08年度注册资料，更新提醒并催办缺少的资料',
    filename: '年度注册核查记录.md',
    plan: [
      '读取项目说明与 M02 技能',
      '核对注册记录、付款凭据和代理人协议',
      '更新提醒并向内部同事催办',
      '自检后提交审核',
    ],
  },
} as const;
export const permissionDescriptions: Record<Permission, string> = {
  read_only: '只读资料与检查，不修改文件或业务记录。',
  ask: '可整理文件；写业务记录、发内部消息和关键判断前先请你批准。',
  full: '按依据继续工作；公司外部消息仍逐条批准，最终结果仍需审核。',
};
export function newThread(permission: Permission = defaultPermissionMode): Thread {
  return {
    phase: 'ready',
    permission,
    draft: '',
    messages: [],
    version: 1,
    token: 0,
    startedAt: 0,
    elapsed: 0,
    processCount: 0,
    allowed: false,
    onceAllowed: false,
    conservative: false,
    feedback: {},
  };
}
export function running(thread: Thread) {
  return thread.phase === 'reading' || thread.phase === 'finishing';
}
export function pending(thread: Thread) {
  return thread.phase === 'approval' || thread.phase === 'review';
}
export function conclusion(project: ProjectKey, conservative: boolean) {
  if (project === 'maintenance')
    return '三项资料已核查；适用年度、付款信息和代理人协议有效期仍待原件确认。';
  return conservative
    ? '两处 K 号写法不一致，保留差异，尚未选择正确编号。'
    : '两处 K 号写法不一致：将 K123465 作为笔误记录，候选统一为 K123456。';
}
export function reviewText(project: ProjectKey, conservative: boolean) {
  return `${conclusion(project, conservative)}\n\n${
    project === 'maintenance'
      ? '已更新核对提醒，并向内部同事王敏发送资料催办。年度适用性和期限未作法规确认。'
      : '原始资料保持不变。判断、原文依据和待确认事项已写入核查记录。'
  }\n\n结果已提交审核。`;
}
