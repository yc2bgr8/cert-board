import type { Pool } from 'pg';
import {
  taskAssignmentSchema,
  taskCatalogSchema,
  type AgentCode,
  type PermissionMode,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { loadManagedAgentDefinition, loadSelectedSkill } from '../agent/definitions.js';

type Db = Pick<Pool, 'query'>;
type Task = {
  code: string;
  owner: AgentCode | 'project' | 'system';
  title: string;
  description: string;
  deliverable: string;
};

const tasks = [
  [
    'R01',
    'registration',
    '启动注册项目',
    '根据目标市场、日期和已知资料倒排里程碑。',
    '立项计划、关键路径和待决定事项',
  ],
  [
    'R02',
    'registration',
    '研判分类与申报路径',
    '对比适用的器械分类和候选申报路径，列出依据。',
    '路径候选、原文依据和待确认项',
  ],
  [
    'R03',
    'registration',
    '准备监管预沟通',
    '整理拟向监管方确认的问题和已有证据。',
    '问题清单和预沟通资料底稿',
  ],
  [
    'R04',
    'registration',
    '规划法规、标准与证据',
    '按产品和目标市场梳理要求，找出证据缺口。',
    '适用要求和证据规划表',
  ],
  [
    'R05',
    'registration',
    '审查研发资料',
    '核对研发材料是否覆盖当前注册要求。',
    '资料审查意见和待补证据',
  ],
  [
    'R06',
    'registration',
    '组织注册测试',
    '整理测试需求、机构候选、送样和进度。',
    '机构对比与测试跟踪表',
  ],
  [
    'R07',
    'registration',
    '收集跨部门资料',
    '对照项目清单找缺项，明确负责人和期限。',
    '缺件清单和催办草稿',
  ],
  [
    'R08',
    'registration',
    '规划和装配申报包',
    '对照清单梳理申报包结构、文档版本和缺件。',
    '申报包目录、附件清单和缺件表',
  ],
  [
    'R09',
    'registration',
    '检查申报资料是否一致',
    '核对同一型号在标签、说明书、测试报告等资料里的关键字段。可以查整包，也可以只查指定字段。',
    '带原文位置的差异报告和待审核事项',
  ],
  [
    'R10',
    'registration',
    '准备提交并跟踪审评',
    '核对提交准备情况，根据人工回执更新跟踪记录。',
    '提交清单、回执记录和后续节点',
  ],
  [
    'R11',
    'registration',
    '拆解发补并起草答复',
    '从监管来函提取问题，关联证据和所需补充材料。',
    '问题台账和带证据引用的答复底稿',
  ],
  [
    'R12',
    'registration',
    '归档获证资料并移交维护',
    '梳理获证结论、证照资料和后续维护事项。',
    '归档清单、复盘和维护移交清单',
  ],
  [
    'M01',
    'maintenance',
    '核对产品证照与销售状态',
    '按型号和市场查询证照、授权及资料缺口。',
    '台账回执和待核实项',
  ],
  [
    'M02',
    'maintenance',
    '核查美国年度注册资料',
    '核对已导入的企业注册记录、年费付款凭据和美国代理人协议。',
    '年度维护核查报告和证据缺口',
  ],
  [
    'M03',
    'maintenance',
    '跟踪加拿大证照维护',
    '核对 MDL、MDEL 以及年度续期和变更事项。',
    '证照维护清单和后续期限',
  ],
  [
    'M04',
    'maintenance',
    '维护其他市场注册与代理',
    '核对目标市场证书、授权及本地代理到期事项。',
    '市场维护清单和待确认项',
  ],
  [
    'M05',
    'maintenance',
    '准备体系审核并跟踪整改',
    '对照审核清单找文件、记录和证书，跟踪整改期限与关闭证据。',
    '迎审证据缺口表和整改跟踪报告',
  ],
  [
    'M06',
    'maintenance',
    '盘点资料和版本',
    '核对资料缺项、过期记录和待更新版本。',
    '盘点结果和需处理事项',
  ],
  [
    'M07',
    'maintenance',
    '评估产品变更的影响',
    '按市场梳理产品、软件、材料、供应商或标签变更的影响。',
    '各市场影响判断、依据和待审核项',
  ],
  [
    'M08',
    'maintenance',
    '核查供应商与材料资质',
    '核对资质文件、材料记录及到期和变更情况。',
    '资质核查清单和证据缺口',
  ],
  [
    'M09',
    'maintenance',
    '检查法规和标准更新',
    '按关注范围查找更新，并判断哪些项目可能受影响。',
    '更新摘要、出处和影响候选',
  ],
  [
    'M10',
    'maintenance',
    '跟踪上市后警戒事项',
    '整理已登记的投诉、事件、证据和人工判断事项。',
    '事件摘要、待确认事项和跟踪期限',
  ],
  [
    'M11',
    'maintenance',
    '核查宣称与标签',
    '对照获准范围和当前资料审查标签与对外宣称。',
    '差异清单和修改建议',
  ],
  [
    'M12',
    'maintenance',
    '整理上市后安全监测记录',
    '汇总已登记的监测记录及处置进展，交负责人判断。',
    '监测摘要和待处理事项',
  ],
  [
    'S01',
    'maintenance',
    '准备销售合规资料包',
    '根据市场、型号和用途准备证照及合规说明。',
    '可审核的报告和资料清单',
  ],
  [
    'S02',
    'maintenance',
    '准备 UPC 申请与维护',
    '整理产品数据、标识及待更新的申请记录。',
    '申请底稿和待确认项',
  ],
  [
    'S03',
    'project',
    '归档项目沟通和会议',
    '整理项目沟通中的决定、行动项和原始记录。',
    '沟通纪要和行动清单',
  ],
  [
    'S04',
    'maintenance',
    '整理周报和管理决策项',
    '汇总工作进度、主要指标和需要管理层处理的事项。',
    '周报草稿和管理决策清单',
  ],
  [
    'S05',
    'system',
    '查看 AI 工作质量管理',
    '跟踪技能版本、审核退回和工作方法的改进。',
    '技能审阅与回退记录',
  ],
] as const;

export const certificationTasks: Task[] = tasks.map(
  ([code, owner, title, description, deliverable]) => ({
    code,
    owner,
    title,
    description,
    deliverable,
  }),
);

export function taskForProject(code: string, agent: AgentCode) {
  const task = certificationTasks.find((entry) => entry.code === code);
  if (!task || (task.owner !== agent && task.owner !== 'project'))
    throw new AppError(409, 'TASK_PROJECT_MISMATCH', '这项任务需要在对应的项目中启动。');
  return task;
}

export async function readTaskCatalog(db: Db, projectId: string, mode: PermissionMode) {
  const project = (
    await db.query<{ project_type: AgentCode }>(
      'SELECT project_type FROM cert_project WHERE id=$1',
      [projectId],
    )
  ).rows[0];
  if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', '没有找到该项目，请重新选择。');
  const agent = project.project_type;
  const definition = await loadManagedAgentDefinition(db, agent, mode);
  const entries = await Promise.all(
    certificationTasks.map(async ({ owner, ...task }) => {
      const skill = definition.skills.find((entry) => entry.id === task.code);
      if (owner === 'system') return { ...task, availability: 'system', skillVersion: null };
      if (owner !== 'project' && owner !== agent)
        return { ...task, availability: 'other_project', skillVersion: null };
      if (!skill) return { ...task, availability: 'pending', skillVersion: null };
      const selected = await loadSelectedSkill(
        db,
        agent,
        { id: skill.id, version: skill.version },
        mode,
      ).catch((error: unknown) => {
        if (error instanceof AppError && error.code === 'SKILL_UNAVAILABLE') return null;
        throw error;
      });
      return selected
        ? {
            ...task,
            availability: selected.developmentOnly ? 'draft' : 'ready',
            skillVersion: skill.version,
          }
        : { ...task, availability: 'pending', skillVersion: null };
    }),
  );
  return taskCatalogSchema.parse({ projectType: agent, entries });
}

export async function readTaskAssignment(db: Db, conversationId: string, userId: string) {
  const stored = (
    await db.query<{ task: unknown }>(
      `SELECT result_json->'task' AS task FROM conversation_command
     WHERE user_id=$1 AND conversation_id=$2 AND action='create' AND result_json ? 'task'`,
      [userId, conversationId],
    )
  ).rows[0]?.task;
  return stored == null ? null : taskAssignmentSchema.parse(stored);
}
