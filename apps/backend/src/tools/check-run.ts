import {
  structuredSubmissionSchema,
  checkReportSchema,
  type ToolMetadata,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { checkSubmission, refreshCheckDataLevel } from '../checks/service.js';
import type { ToolDefinition } from './registry.js';

const exampleCitation = {
  documentId: '10000000-0000-4000-8000-000000000001',
  version: 1,
  page: 1,
  quote: 'EXAMPLE-001',
};
const metadata: ToolMetadata = {
  name: 'check_run',
  version: 'builtin-checks-v2',
  publication: 'published',
  effect: 'read',
  modes: ['read_only', 'ask', 'full'],
  approvalInAsk: false,
  outputDataLevel: 'dynamic',
  authorizationAction: 'project.read',
  description: {
    purpose: '提交审核前核对结构化结果与资料库原文，执行 V1、V3 和适用的 V6 期限、V7 数值复算。',
    whenToUse: '已有doc_read取得的真实引用和本项目已保存工作区版本，准备检查交付时使用。',
    avoid:
      '不要用它代替doc_read或法规判断；它不证明模型实际读过，不验证哪个K号正确。通过后仍须submit_for_review，审批只能由人在浏览器完成。',
    parameters:
      '直接传skill、workspaceVersion、conclusion、claims、decisions、evidence、missing、uncertain、nextStep。decisions必填，没有过程判断时传[]，每项至少一条原文。期限的value取deadline_calc的ISO到期点，deadlineCalculation填同一计算参数。数值复算时在该条claim填quantityCheck:true、数值或范围（如 60 或 "20–25"）和单位（如 min 或 °C），每条原文均须含对应值与单位。不同数值分条提交。陈述与判断合计最多20条，引用合计40条；引用用documentId/version/page/quote。K号是字符串，unit为null。V2 另用官方查询和标识符核对工具。例子为虚构格式，实际须用资料回执。',
    example: {
      skill: { id: 'R09', version: '0.1.0' },
      workspaceVersion: '10000000-0000-4000-8000-000000000002',
      conclusion: '虚构格式示例，实际结论须依据读取资料。',
      claims: [
        {
          id: 'C1',
          object: '对比器械',
          field: 'predicate_k_number',
          value: 'EXAMPLE-001',
          unit: null,
          sources: [exampleCitation],
          status: 'checked',
        },
      ],
      evidence: [exampleCitation],
      decisions: [
        {
          id: 'D1',
          subject: '编号写法的处理',
          choice: '保留当前写法并标为待确认',
          alternatives: ['在未核对前修改编号'],
          reason: '仅凭这条摘录不能证明号码真实性。',
          sources: [exampleCitation],
          risk: 'high',
        },
      ],
      missing: [],
      uncertain: ['正确编号需业务人员核实。'],
      nextStep: '核对原件后提交审核。',
    },
  },
};

export function checkRunTool(): ToolDefinition {
  return {
    metadata,
    inputSchema: structuredSubmissionSchema,
    outputSchema: checkReportSchema,
    async execute(ctx, input) {
      if (!ctx.projectId)
        throw new AppError(
          400,
          'CHECK_PROJECT_REQUIRED',
          '请先从项目列表进入项目，再读取资料并检查。',
        );
      const report = await checkSubmission(
        ctx.tx,
        { runId: ctx.runId, userId: ctx.actor.userId },
        input,
      );
      return { data: report, dataLevel: report.dataLevel };
    },
    async refreshDataLevel(ctx, data) {
      const report = checkReportSchema.parse(data);
      return refreshCheckDataLevel(
        ctx.tx,
        { runId: ctx.runId, userId: ctx.actor.userId },
        report.citations,
      );
    },
  };
}
